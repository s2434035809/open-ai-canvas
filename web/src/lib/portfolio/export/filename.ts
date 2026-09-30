/**
 * 导出文件名生成（纯函数）。
 *
 * 与落盘分开，是为了让命名规则能脱离浏览器单测——文件名里的非法字符处理最容易被
 * 忽略，而它在 Windows 上会直接导致保存失败。
 */

/** 各平台的文件名非法字符（Windows 最严格，按它取交集）。 */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeFilename(value: string): string {
    return (
        String(value ?? "")
            .replace(INVALID_FILENAME_CHARS, "")
            .trim()
            .replace(/\s+/g, " ")
            // 前导点先去掉再限长：`.hidden` 这类名字在某些系统上会被当成隐藏文件。
            .replace(/^\.+/, "")
            .trim()
            .slice(0, 60)
            .trim()
    );
}

/** 生成下载文件名，如「我的作品集-当前页.png」。标题为空时退回「作品集」。 */
export function portfolioExportFilename(title: string, suffix: string, extension: string): string {
    const base = sanitizeFilename(title) || "作品集";
    const tail = sanitizeFilename(suffix);
    const ext = String(extension ?? "").replace(/^\./, "");
    return `${base}${tail ? `-${tail}` : ""}.${ext}`;
}
