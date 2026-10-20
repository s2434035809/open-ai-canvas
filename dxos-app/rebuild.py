#!/usr/bin/env python3
"""Build a DX OS frontend from an isolated export of a local git ref."""
import argparse
import hashlib
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BUN_IMAGE = 'oven/bun:1.3.13'
LOCK_MARKER = '.bun-lock-sha256'


def lock_digest(stage):
    return hashlib.sha256((stage / 'web' / 'bun.lock').read_bytes()).hexdigest()


def volume_marker(volume):
    result = subprocess.run(['docker', 'run', '--rm', '-v', f'{volume}:/nm', 'alpine', 'sh', '-c',
                             f'cat /nm/{LOCK_MARKER} 2>/dev/null || true'],
                            capture_output=True, text=True)
    return result.stdout.strip()


def write_volume_marker(volume, digest):
    subprocess.run(['docker', 'run', '--rm', '-v', f'{volume}:/nm', 'alpine', 'sh', '-c',
                    f'printf %s {digest} > /nm/{LOCK_MARKER}'], check=True)


def install_dependencies(stage, volume):
    print(f'刷新 Bun 依赖卷 {volume}（按 web/bun.lock 安装，需要联网）…')
    subprocess.run(['docker', 'run', '--rm',
                    '-v', f'{stage}:/app', '-v', f'{volume}:/app/web/node_modules',
                    '-w', '/app/web', BUN_IMAGE, 'sh', '-c', 'bun install --frozen-lockfile'], check=True)
    write_volume_marker(volume, lock_digest(stage))

def replace_once(path, old, new):
    source = path.read_text()
    if source.count(old) != 1:
        raise RuntimeError(f'上游代码已变化，请重新检查 DX OS 适配位置：{path.name}')
    path.write_text(source.replace(old, new))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', default='HEAD',
                        help='要打包的 git 引用，默认当前检出（HEAD）')
    parser.add_argument('--backend', choices=('bundled', 'external'), default='bundled',
                        help='bundled：同时打入后端二进制；external：只打包前端')
    parser.add_argument('--backend-bin', default=None,
                        help='bundled 模式使用的后端二进制（默认用仓库内的旧二进制，通常应显式指向 dxos-app/backend-bin/yingce-backend）')
    parser.add_argument('--no-package', action='store_true',
                        help='只构建前端 dist，不调用 build.py 打包')
    parser.add_argument('--source-root', default=None,
                        help='从该目录取源码（通常是 git archive 导出的目标提交）；默认当前仓库')
    parser.add_argument('--package-script', default=None,
                        help='打包脚本路径；配合 --source-root 使用当前仓库里最新的 dxos-app/build.py')
    parser.add_argument('--deps-volume', default='oc-web-nm',
                        help='存放 web/node_modules 的 Docker 卷名')
    parser.add_argument('--refresh-deps', action='store_true',
                        help='强制按当前 web/bun.lock 重装依赖卷（上游升级依赖后用）')
    args = parser.parse_args()
    builds = REPO / '.local/dxos-builds'
    builds.mkdir(parents=True, exist_ok=True)
    if args.source_root:
        # 目标源码已由调用方导出（更新器用 git archive），这里只负责构建与打包。
        stage = Path(args.source_root).resolve()
        if not (stage / 'web' / 'bun.lock').is_file():
            raise SystemExit(f'--source-root 不是完整的仓库导出：{stage}')
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=stage, text=True).strip() if (stage / '.git').exists() else subprocess.check_output(['git', 'rev-parse', args.ref], cwd=REPO, text=True).strip()
    else:
        commit = subprocess.check_output(['git', 'rev-parse', args.ref], cwd=REPO, text=True).strip()
        stage = Path(tempfile.mkdtemp(prefix=commit[:8] + '-', dir=builds))
        archive = stage / 'source.tar'
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(archive), commit], cwd=REPO, check=True)
        with tarfile.open(archive) as bundle:
            bundle.extractall(stage)
        archive.unlink()
    router = stage / 'web/src/router.tsx'
    content = router.read_text()
    if content.count('createBrowserRouter') != 2:
        raise RuntimeError('无法识别上游路由工厂，停止构建')
    router.write_text(content.replace('createBrowserRouter', 'createHashRouter'))
    replace_once(stage / 'web/src/services/api/request.ts',
                 'axios.create({ baseURL: apiBaseURL, withCredentials: true })',
                 'axios.create({ baseURL: apiBaseURL, withCredentials: false, withXSRFToken: false, xsrfCookieName: "" })')
    vite_config = stage / 'web/vite.config.ts'
    vite_source = vite_config.read_text()
    if 'base: "./"' not in vite_source:
        replace_once(vite_config, 'export default defineConfig({',
                     'export default defineConfig({\n    base: "./",')
    digest = lock_digest(stage)
    recorded = volume_marker(args.deps_volume)
    if args.refresh_deps or (recorded and recorded != digest):
        reason = '显式要求刷新' if args.refresh_deps else 'web/bun.lock 已变化'
        print(f'依赖卷与当前锁文件不一致（{reason}）')
        install_dependencies(stage, args.deps_volume)
    elif not recorded:
        print(f'依赖卷 {args.deps_volume} 没有锁文件标记，先沿用现有依赖；构建报缺依赖时加 --refresh-deps')
    metadata = {'commit': commit, 'ref': args.ref, 'version': (stage / 'VERSION').read_text().strip(),
                'adaptations': ['hash-router', 'host-cookie-auth', 'relative-assets', 'opaque-frame-locks']}
    subprocess.run(['docker', 'run', '--rm', '--network', 'none',
                    '-v', f'{stage}:/app', '-v', f'{args.deps_volume}:/app/web/node_modules:ro',
                    '--tmpfs', '/app/web/node_modules/.vite-temp',
                    '-w', '/app/web', '-e', f'CANVAS_BUILD_COMMIT={commit}',
                    BUN_IMAGE, 'sh', '-c',
                    'bun run build'], check=True)
    (stage / 'web/dist/dxos-build-source.json').write_text(json.dumps(metadata, indent=2) + '\n')
    if not args.no_package:
        package_script = Path(args.package_script) if args.package_script else REPO / 'dxos-app/build.py'
        command = ['python3', str(package_script), '--dist', str(stage / 'web/dist'),
                   '--channel', 'dev', '--backend', args.backend,
                   '--repo-dir', str(stage)]
        if args.backend_bin:
            command += ['--backend-bin', args.backend_bin]
        subprocess.run(command, check=True)
    print('Isolated source:', stage)

if __name__ == '__main__':
    main()
