"use strict";

function createMcpBridge(options = {}) {
  const client = options.client;

  return {
    async browserAction(toolInput) {
      const actionMap = {
        navigate: { name: "playwright__browser_navigate", args: { url: toolInput.url } },
        click: { name: "playwright__browser_click", args: { selector: toolInput.selector } },
        fill: { name: "playwright__browser_type", args: { selector: toolInput.selector, text: toolInput.value } },
        screenshot: { name: "playwright__browser_take_screenshot", args: {} },
        get_text: { name: "playwright__browser_snapshot", args: {} },
        evaluate: { name: "playwright__browser_evaluate", args: { function: toolInput.script } },
        wait: { name: "playwright__browser_wait_for", args: { time: toolInput.timeout || 1000 } },
      };
      const mapped = actionMap[toolInput.action];
      if (!mapped) throw new Error(`Unsupported browser action: ${toolInput.action}`);
      const result = await client.executeTool(mapped.name, mapped.args);
      if (!result.ok) throw new Error(result.error || "Browser action failed");
      return { data: result.data };
    },
  };
}

module.exports = { createMcpBridge };
