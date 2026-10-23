import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { createDetailClient, detailFillFailure, detailName } from "./detail-wire";

const en = i18n.getFixedT("en");
const ja = i18n.getFixedT("ja");

describe("how the popup names a personal detail (ADR 0061)", () => {
  it("names a birth date by the part the page asks for", () => {
    expect(detailName("birth-date", en)).toBe("your birth date");
    expect(detailName("birth-date", en, "yyyymmdd")).toBe("your birth date");
    expect(detailName("birth-date", en, "yyyymm")).toBe("your birth year and month");
    expect(detailName("birth-date", en, "mmdd")).toBe("your birth month and day");
  });

  it("names the other details", () => {
    expect(detailName("phone-last-4", en)).toBe("the last 4 digits of your phone number");
    expect(detailName("card-last-4", en)).toBe("the last 4 digits of your card number");
    expect(detailName("card-code", en)).toBe("your card's security code");
    expect(detailName("secret-answer", en)).toBe("the answer to your secret question");
    expect(detailName("member-id", en)).toBe("your member or customer number");
  });

  it("names them in Japanese (ADR 0043)", () => {
    expect(detailName("birth-date", ja, "yyyymm")).toBe("生年月");
    expect(detailName("card-code", ja)).toBe("カードのセキュリティコード");
  });
});

describe("the popup's message for a Fill that filled nothing", () => {
  it("says why for each reason", () => {
    expect(detailFillFailure("document-gone", en)).toBe("The page changed, so nothing was filled.");
    expect(detailFillFailure("not-a-candidate", en)).toBe("This page no longer asks for it.");
    expect(detailFillFailure("unreadable", en)).toBe(
      "That field does not hold a value Pateat can use here.",
    );
    expect(detailFillFailure("unavailable", en)).toBe(
      "Pateat cannot read that field now. Unlock the vault and try again.",
    );
    expect(detailFillFailure("not-filled", en)).toBe("The page did not accept the value.");
    expect(detailFillFailure("not-filled", ja)).toBe("ページが値を受け付けませんでした。");
  });
});

describe("the popup's detail client", () => {
  const source = {
    connectionId: "personal",
    itemId: "identity",
    fieldId: "birth",
    itemLabel: "Me",
    fieldLabel: "Birth date",
  };

  it("sends each request with its type and parses the answer", async () => {
    const send = vi.fn<(message: unknown) => Promise<unknown>>();
    const client = createDetailClient(send);
    send.mockResolvedValueOnce({
      ok: true,
      origin: "https://shop.example",
      offer: {
        documentId: "doc",
        details: [{ detail: "birth-date", format: "yyyymm", candidates: [source] }],
      },
      links: [],
    });
    expect((await client.get(3)).ok).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ version: 1, type: "login.detail.get", tabId: 3 });

    send.mockResolvedValueOnce({ ok: false, reason: "unreadable" });
    expect(
      await client.fill({
        tabId: 3,
        documentId: "doc",
        detail: "birth-date",
        connectionId: "personal",
        itemId: "identity",
        fieldId: "birth",
      }),
    ).toEqual({ ok: false, reason: "unreadable" });
    expect(send).toHaveBeenLastCalledWith({
      version: 1,
      type: "login.detail.fill",
      tabId: 3,
      documentId: "doc",
      detail: "birth-date",
      connectionId: "personal",
      itemId: "identity",
      fieldId: "birth",
    });

    send.mockResolvedValueOnce({ ok: true });
    expect(await client.remove(3, "card-code")).toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith({
      version: 1,
      type: "login.detail.remove",
      tabId: 3,
      detail: "card-code",
    });
  });

  it("refuses an answer that carries a value", async () => {
    const client = createDetailClient(async () => ({
      ok: true,
      origin: "https://shop.example",
      links: [{ detail: "card-code", itemLabel: "Card", fieldLabel: "Code", value: "123" }],
    }));
    await expect(client.get(3)).rejects.toThrow();
  });
});
