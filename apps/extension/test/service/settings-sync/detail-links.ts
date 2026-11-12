import { expect, it } from "vitest";
import { mergeSyncedSettings, syncedSettings } from "../../../src/service/settings-sync";
import type { DetailLinksContext } from "./context";

export function registerDetailLinks({
  link,
  setup,
  settingsOf,
  state,
  baseOf,
  CONNECTION,
  never,
  localConnection,
  birthDate,
  cardCode,
  site,
  OTHER_PROFILE,
}: DetailLinksContext) {
  it.each(["birth-date", "secret-answer"] as const)(
    "syncs the same login IDs' %s links from different servers without losing either",
    async (detail) => {
      const serviceLink = link(
        "https://bank.example",
        detail,
        { itemId: "item-1", field: { custom: "Answer" } },
        detail === "secret-answer" ? "name of your first pet" : undefined,
      );
      const localLink = { ...serviceLink, server: "cloud-eu" };
      const h = setup({
        local: settingsOf({ detailLinks: [localLink] }),
        service: state(5, settingsOf({ detailLinks: [serviceLink] })),
        base: baseOf(4, settingsOf()),
      });
      expect(await h.sync.run(CONNECTION, never)).toBe("synced");
      expect(h.local()?.settings.detailLinks).toEqual([serviceLink, localLink]);
      expect(h.service().settings?.detailLinks).toEqual([serviceLink, localLink]);
    },
  );

  it("reconciles one answer field whose reference properties have different orders with the service winning", async () => {
    const answer = link("https://bank.example", "secret-answer", {
      itemId: "item-1",
      field: { custom: "Answer" },
    });
    const localLink = {
      ...answer,
      source: { ...answer.source, field: { custom: "Answer", position: 1, count: 2 } },
    };
    const serviceLink = {
      ...answer,
      source: { ...answer.source, field: { count: 2, position: 1, custom: "Answer" } },
      question: "name of your first pet",
    };
    const h = setup({
      local: settingsOf({ detailLinks: [localLink] }),
      service: state(5, settingsOf({ detailLinks: [serviceLink] })),
      base: baseOf(4, settingsOf()),
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    expect(h.local()?.settings.detailLinks).toEqual([serviceLink]);
    expect(h.service().settings?.detailLinks).toEqual([serviceLink]);
  });

  it("uploads this device's links to the owner's settings", async () => {
    const local = settingsOf({ connections: [localConnection], detailLinks: [birthDate] });
    const { sync, service, base } = setup({ local });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(service()).toEqual(state(1, settingsOf({ detailLinks: [birthDate] })));
    expect(base()).toMatchObject({ revision: 1, settings: { detailLinks: [birthDate] } });
  });

  it("downloads a link another device added", async () => {
    const agreed = settingsOf({ detailLinks: [birthDate] });
    const {
      sync,
      transport,
      local: after,
      applied,
    } = setup({
      local: { ...agreed, connections: [localConnection] },
      service: state(5, settingsOf({ detailLinks: [birthDate, cardCode] })),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.settings.detailLinks).toEqual([birthDate, cardCode]);
    expect(after()?.settings.connections).toEqual([localConnection]);
    expect(applied).toHaveBeenCalledOnce();
  });

  it("uploads links a device holds while its base predates synced links", async () => {
    // A base recorded before links were synced lacks them; they are local additions.
    const { detailLinks: _none, ...agreed } = settingsOf();
    const {
      sync,
      service,
      local: after,
    } = setup({
      local: settingsOf({ detailLinks: [birthDate] }),
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(service().settings?.detailLinks).toEqual([birthDate]);
    expect(after()?.settings.detailLinks).toEqual([birthDate]);
  });

  it("merges per link: removals and additions on each side, the service's change wins", () => {
    const answer = link("https://bank.example", "secret-answer", {
      itemId: "item-1",
      field: { custom: "Answer" },
    });
    const base = syncedSettings(settingsOf({ detailLinks: [birthDate, cardCode, answer] }));
    // This device removed the card code and pointed the birth date at another item; the
    // service pointed the birth date elsewhere too and added a link for another site.
    const local = syncedSettings(
      settingsOf({
        detailLinks: [
          link("https://bank.example", "birth-date", {
            itemId: "identity-local",
            field: { custom: "Birth date" },
          }),
          answer,
        ],
      }),
    );
    const serviceBirthDate = link("https://bank.example", "birth-date", {
      itemId: "identity-service",
      field: { custom: "Birth date" },
    });
    const service = syncedSettings(
      settingsOf({
        detailLinks: [serviceBirthDate, cardCode, answer, link("https://shop.example")],
      }),
    );
    expect(mergeSyncedSettings({ service: base, local: base }, local, service).detailLinks).toEqual(
      [serviceBirthDate, answer, link("https://shop.example")],
    );
  });

  it("keys answers by field, so two answer fields of one item both stay", () => {
    const first = link("https://bank.example", "secret-answer", {
      itemId: "item-1",
      field: { custom: "First pet" },
    });
    const second = link("https://bank.example", "secret-answer", {
      itemId: "item-1",
      field: { custom: "Birth town" },
    });
    const base = syncedSettings(settingsOf());
    expect(
      mergeSyncedSettings(
        { service: base, local: base },
        syncedSettings(settingsOf({ detailLinks: [first] })),
        syncedSettings(settingsOf({ detailLinks: [second] })),
      ).detailLinks,
    ).toEqual([second, first]);
  });

  it("keeps the service's link when a local link stores the same question", async () => {
    const question = "what was the name of your first pet";
    const serviceAnswer = link(
      "https://bank.example",
      "secret-answer",
      { itemId: "item-1", field: { custom: "Answer 1" } },
      question,
    );
    const localAnswer = link(
      "https://bank.example",
      "secret-answer",
      { itemId: "item-1", field: { custom: "Answer 2" } },
      question,
    );
    const {
      sync,
      service,
      local: after,
    } = setup({
      local: settingsOf({ detailLinks: [localAnswer, birthDate] }),
      service: state(5, settingsOf({ detailLinks: [serviceAnswer] })),
      base: baseOf(4, settingsOf()),
    });
    // Both links together would fail the settings' duplicate-question check.
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(service().settings?.detailLinks).toEqual([serviceAnswer, birthDate]);
    expect(after()?.settings.detailLinks).toEqual([serviceAnswer, birthDate]);
  });

  it("settles a same-question clash against an agreed base, then writes nothing", async () => {
    const question = "what was the name of your first pet";
    const answer = (custom: string) =>
      link("https://bank.example", "secret-answer", { itemId: "item-1", field: { custom } });
    // Both sides agreed on the birth date link and an answer without a question. This
    // device then confirmed a question for "Answer 2"; another device confirmed the same
    // question for "Answer 1".
    const agreed = settingsOf({ detailLinks: [birthDate, answer("Answer 1"), answer("Answer 2")] });
    const serviceAnswer = { ...answer("Answer 1"), question };
    const localAnswer = { ...answer("Answer 2"), question };
    const h = setup({
      local: settingsOf({ detailLinks: [birthDate, answer("Answer 1"), localAnswer] }),
      service: state(
        5,
        settingsOf({ detailLinks: [birthDate, serviceAnswer, answer("Answer 2")] }),
      ),
      base: baseOf(4, agreed),
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    // The service's question stands; this device's "Answer 2" keeps its link without
    // the clashing question, as the service holds it.
    const settled = [birthDate, serviceAnswer, answer("Answer 2")];
    expect(h.transport.saveSettings).not.toHaveBeenCalled();
    expect(h.service()).toEqual(
      state(5, settingsOf({ detailLinks: [birthDate, serviceAnswer, answer("Answer 2")] })),
    );
    expect(h.local()?.settings.detailLinks).toEqual(settled);
    expect(h.local()?.revision).toBe(8);

    // The next sync finds both sides equal: no upload and no local write.
    h.applied.mockClear();
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    expect(h.transport.saveSettings).not.toHaveBeenCalled();
    expect(h.local()?.revision).toBe(8);
    expect(h.applied).not.toHaveBeenCalled();
  });

  it("removes a link deleted on this device from the service", async () => {
    const agreed = settingsOf({ detailLinks: [birthDate, cardCode] });
    const { sync, service } = setup({
      local: settingsOf({ detailLinks: [cardCode] }),
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(service()).toEqual(state(5, settingsOf({ detailLinks: [cardCode] })));
  });

  it("merges again with the service's links after a conflicting write", async () => {
    const agreed = settingsOf({ detailLinks: [birthDate] });
    const h = setup({
      local: settingsOf({ detailLinks: [birthDate, cardCode] }),
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    // Another device removed the birth date link while this upload was on its way.
    h.transport.saveSettings.mockImplementationOnce(async () => {
      const current = state(5, settingsOf());
      h.setService(current);
      return { kind: "conflict", current: structuredClone(current) };
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    expect(h.service()).toEqual(state(6, settingsOf({ detailLinks: [cardCode] })));
    expect(h.local()?.settings.detailLinks).toEqual([cardCode]);
  });

  it("keeps this device's links when it adopts another profile, as bindings", async () => {
    // Links belong to the owner, not to a profile (ADR 0076).
    const local = settingsOf({
      excludedSites: [site("local-only.example")],
      detailLinks: [cardCode],
    });
    const remote = settingsOf({
      excludedSites: [site("intranet.example")],
      detailLinks: [birthDate],
    });
    const { sync, service, local: after } = setup({ local, service: state(3, remote) });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const merged = settingsOf({
      excludedSites: [site("intranet.example")],
      detailLinks: [birthDate, cardCode],
    });
    expect(service()).toEqual(state(4, merged));
    expect(after()?.settings).toEqual(merged);
  });

  it("does not bring back a link removed while this device moved to a new profile", async () => {
    const agreed = settingsOf({ detailLinks: [birthDate, cardCode] });
    const h = setup({
      local: agreed,
      service: {
        ...state(6, settingsOf({ detailLinks: [cardCode] })),
        profileId: OTHER_PROFILE,
        newProfile: true,
      },
      base: baseOf(4, agreed),
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    expect(h.local()?.settings.detailLinks).toEqual([cardCode]);
    expect(h.service().settings?.detailLinks).toEqual([cardCode]);
  });

  it("treats reordered links as unchanged", async () => {
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: settingsOf({ detailLinks: [cardCode, birthDate] }),
      service: state(4, settingsOf({ detailLinks: [birthDate, cardCode] })),
      base: baseOf(4, settingsOf({ detailLinks: [birthDate, cardCode] })),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.revision).toBe(7);
  });

  it("refuses an upload whose links exceed the service's body limit", async () => {
    // Long custom field names fill the document past MAX_SETTINGS_DOCUMENT_BYTES.
    const links = Array.from({ length: 1000 }, (_, index) =>
      link(`https://site-${index}.example`, "birth-date", {
        itemId: "identity-1",
        field: { custom: `${"F".repeat(120)}${index}` },
      }),
    );
    const { sync, transport } = setup({ local: settingsOf({ detailLinks: links }) });
    expect(await sync.run(CONNECTION, never)).toBe("too-large");
    expect(transport.saveSettings).not.toHaveBeenCalled();
  });
}
