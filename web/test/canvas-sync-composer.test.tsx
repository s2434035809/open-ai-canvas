import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentChatComposer } from "../src/components/canvas/canvas-cloud-agent-composer";
import { canvasThemes } from "../src/lib/canvas-theme";

test("unconfirmed sync prevents sending without disabling the real Agent input", () => {
    const markup = renderToStaticMarkup(<AgentChatComposer prompt="Keep this draft" submitDisabled placeholder="Compose" theme={canvasThemes.dark} onPromptChange={() => {}} onSubmit={() => {}} />);
    const sendButton = markup.match(/<button[^>]*aria-label="发送"[^>]*>/)?.[0];
    expect(sendButton).toBeDefined();
    expect(sendButton).toContain("disabled");
    expect(markup).toContain('aria-label="Agent 输入"');
    expect(markup).not.toContain('contenteditable="false"');
});
