import { getFoundationStatus, isStatusRequest } from "@pateat/contracts";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

export default defineBackground(() => {
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id === browser.runtime.id &&
      sender.url === browser.runtime.getURL("/options.html") &&
      isStatusRequest(message)
    ) {
      sendResponse(getFoundationStatus());
    }

    if (
      import.meta.env.MODE === "probe" &&
      sender.id === browser.runtime.id &&
      sender.tab?.id !== undefined &&
      sender.url?.startsWith("http://127.0.0.1:") &&
      message?.type === "pateat.test.document"
    ) {
      sendResponse({
        tabId: sender.tab.id,
        frameId: sender.frameId,
        documentId: sender.documentId,
        active: sender.tab.active,
      });
    }
    return false;
  });
});
