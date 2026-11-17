import { nearCodeHeadings } from "../observation/extract-near-text";
import { codeFieldSource } from "./code-source";
import { shownCodeInputs } from "./sign-in-state";

/**
 * A digest of the page's first shown code field as a watched login reads it (ADR 0027
 * amendment of 2026-11-17): where its code comes from (`codeFieldSource`) and the headings
 * of its part of the page (`nearCodeHeadings`), or that no code field shows. A dialog that
 * swaps the emailed code's page for the authenticator app's in one document and one
 * input, as Luma's does, gets another digest; digits the person types do not change it.
 * Only the digest leaves this function, never a text or a value of the page.
 */
export async function codePageDigest(document: Document): Promise<string> {
  const [field] = shownCodeInputs(document);
  const read = field ? [codeFieldSource(field) ?? "", ...nearCodeHeadings(field)] : null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(read)),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
