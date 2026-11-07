import type * as Sdk from "@bitwarden/sdk-internal";
import * as v from "valibot";

import { bitwardenEmail } from "./email";
import { normalizeBitwardenProfile } from "./environment";
import { failure, mismatch, type BitwardenResult } from "./errors";
import { encryptedCatalogContextSchema } from "./local-crypto";
import { encryptedSyncEnvelopeSchema } from "./models";
import { createBitwardenUriMatchContext } from "./uri";

import {
  AdmissionFailure,
  reject,
  rejectMismatch,
  record,
  same,
  read,
  requiredText,
  optionalCollectionText,
  identifier,
  normalizedEmail,
  list,
  optionalList,
  boolean,
  encrypted,
  integer,
  kdf,
  collectionType,
  containedId,
  modernUnlock,
  sameUnlock,
  accountKeys,
  sameAccountState,
  accountFromProfile,
  tokenClaims,
  cipherDto,
  type OrganizationPolicyContext,
  uriMatchDefault,
  uuid,
  type RecordValue,
} from "./account-response";
import type { BitwardenAccountMapper, PreparedBitwardenAccount } from "./account-types";

const email = bitwardenEmail;
const bindingSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("bootstrap"), email }),
  v.strictObject({
    kind: v.literal("known"),
    profile: v.unknown(),
    email,
    userId: uuid,
    accountVersion: v.picklist(["v1", "v2"]),
    minimumSecurityVersion: v.picklist([1, 2]),
  }),
]);

/** Fixed provider/account context. No network, passwords, native crypto, migrations or cache writes. */
export function createBitwardenAccountMapper(
  profileInput: unknown,
  bindingInput: unknown,
  options: { nowSeconds?: () => number } = {},
): BitwardenResult<BitwardenAccountMapper> {
  const profile = normalizeBitwardenProfile(profileInput);
  if (!profile.ok) return profile;
  const parsedBinding = v.safeParse(bindingSchema, bindingInput);
  if (!parsedBinding.success) return failure("invalid-request");
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "nowSeconds") ||
    (options.nowSeconds !== undefined && typeof options.nowSeconds !== "function")
  )
    return failure("invalid-options");
  const binding = parsedBinding.output;
  if (binding.kind === "known") {
    const previous = normalizeBitwardenProfile(binding.profile);
    if (!previous.ok || !same(previous.data, profile.data)) return failure("account-mismatch");
  }
  const expectedEmail = binding.email.toLowerCase();
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  return {
    ok: true,
    data: Object.freeze({
      profile: profile.data,
      map(input: unknown): BitwardenResult<PreparedBitwardenAccount> {
        try {
          // Snapshot caller-owned DTOs before consistency checks and never retain them in this mapper.
          const request = record(structuredClone(input));
          if (request["connectionId"] !== profile.data.connectionId)
            return failure("connection-mismatch");
          const authenticated = record(request["authenticated"]);
          if (authenticated["kind"] !== "authenticated") reject("invalid-request");
          const tokens = record(authenticated["tokens"]);
          if (tokens["tokenType"] !== "Bearer") reject();
          integer(tokens["expiresIn"]);
          const now = nowSeconds();
          if (!Number.isSafeInteger(now) || now < 0) reject("invalid-options");
          const claims = tokenClaims(tokens["accessToken"], now);
          const syncResult = v.safeParse(encryptedSyncEnvelopeSchema, request["sync"]);
          if (!syncResult.success) reject();
          const sync = syncResult.output;
          const account = record(sync.profile);
          const userId = identifier(read(account, "id"));
          const actualEmail = normalizedEmail(read(account, "email"));
          if (identifier(claims["sub"]) !== userId) rejectMismatch("token-subject");
          if (normalizedEmail(claims["email"]) !== actualEmail) rejectMismatch("token-email");
          if (actualEmail !== expectedEmail) rejectMismatch("configured-email");
          if (binding.kind === "known" && binding.userId !== userId) rejectMismatch("known-user");
          const stamp = read(account, "securityStamp");
          if (stamp != null) requiredText(stamp, 200);
          if (claims["sstamp"] != null) {
            const tokenStamp = requiredText(claims["sstamp"], 200);
            if (stamp != null && tokenStamp.toLowerCase() !== (stamp as string).toLowerCase())
              rejectMismatch("security-stamp");
          }
          const encryptedAccount = record(authenticated["encryptedAccount"]);
          // Password-reset and key-connector ceremonies are outside ordinary password unlock.
          for (const [source, names] of [
            [account, ["forcePasswordReset", "usesKeyConnector"]],
            [encryptedAccount, ["forcePasswordReset", "apiUseKeyConnector"]],
          ] as const) {
            for (const name of names) {
              const flag = read(source, name);
              if (flag != null && typeof flag !== "boolean") reject();
              if (flag === true) reject("unsupported-unlock");
            }
          }
          const responseState = accountFromProfile(account);
          const accountVersion = "V2" in responseState ? "v2" : "v1";
          if (
            binding.kind === "known" &&
            binding.accountVersion === "v2" &&
            accountVersion !== "v2"
          )
            reject("security-downgrade");
          const tokenKeys = read(encryptedAccount, "accountKeys");
          if (tokenKeys != null) {
            const tokenState = accountKeys(tokenKeys);
            if (!sameAccountState(tokenState, responseState)) rejectMismatch("token-account-keys");
            // Optional older-sync omission must not discard a present token signature.
            // Retain it so the local SDK verifies every supplied cryptographic statement.
            if (
              "V2" in tokenState &&
              "V2" in responseState &&
              responseState.V2.signed_public_key == null
            )
              responseState.V2.signed_public_key = tokenState.V2.signed_public_key;
          }
          // The SDK requires V2's signed public key, so one of the two responses must carry it.
          const cryptographicState: Sdk.WrappedAccountCryptographicState = (() => {
            if ("V1" in responseState) return responseState;
            const { signed_public_key: signedPublicKey, ...state } = responseState.V2;
            if (signedPublicKey == null) reject();
            return { V2: { ...state, signed_public_key: signedPublicKey } };
          })();
          const tokenPrivate = read(encryptedAccount, "privateKey");
          const privateKey =
            "V1" in cryptographicState
              ? cryptographicState.V1.private_key
              : cryptographicState.V2.private_key;
          if (tokenPrivate != null && tokenPrivate !== privateKey)
            rejectMismatch("token-private-key");
          let unlock: Sdk.MasterPasswordUnlockData;
          const userDecryption = sync.userDecryption;
          if (userDecryption != null) {
            const raw = read(userDecryption, "masterPasswordUnlock");
            if (raw == null) reject("unsupported-unlock");
            unlock = modernUnlock(raw);
            const id = containedId(read(userDecryption, "userKeyId"));
            if (id && unlock.containedKeyId && id !== unlock.containedKeyId) reject();
          } else {
            if (accountVersion !== "v1") reject("unsupported-unlock");
            unlock = {
              kdf: kdf({
                kdfType: read(encryptedAccount, "kdf"),
                iterations: read(encryptedAccount, "kdfIterations"),
                memory: read(encryptedAccount, "kdfMemory"),
                parallelism: read(encryptedAccount, "kdfParallelism"),
              }),
              masterKeyWrappedUserKey: encrypted(read(account, "key")),
              salt: actualEmail,
            };
          }
          for (const source of [account, encryptedAccount]) {
            const key = read(source, "key");
            if (key != null && key !== unlock.masterKeyWrappedUserKey) rejectMismatch("user-key");
          }
          const tokenDecryption = read(encryptedAccount, "userDecryptionOptions");
          if (tokenDecryption != null) {
            const raw = read(record(tokenDecryption), "masterPasswordUnlock");
            if (raw != null && !sameUnlock(modernUnlock(raw), unlock))
              rejectMismatch("token-unlock");
          }
          const organizations = new Map<string, string>();
          const organizationIds = new Set<string>();
          const policyContexts = new Map<string, OrganizationPolicyContext>();
          const providerOrganizationIds = new Set<string>();
          // Provider membership only adds an exemption; malformed entries are ignored as before.
          const providerOrganizations = read(account, "providerOrganizations");
          for (const raw of Array.isArray(providerOrganizations)
            ? providerOrganizations.slice(0, 1_000)
            : []) {
            const id =
              raw && typeof raw === "object" && !Array.isArray(raw)
                ? v.safeParse(uuid, (raw as RecordValue)["id"] ?? (raw as RecordValue)["Id"])
                : undefined;
            if (id?.success) providerOrganizationIds.add(id.output);
          }
          for (const raw of optionalList(read(account, "organizations"), 1_000)) {
            const organization = record(raw);
            const id = identifier(read(organization, "id"));
            if (organizationIds.has(id)) reject();
            organizationIds.add(id);
            const enabled = read(organization, "enabled");
            if (typeof enabled !== "boolean") reject();
            const status = read(organization, "status");
            if (status != null && status !== 2) reject();
            const key = read(organization, "key");
            if (enabled && key != null) organizations.set(id, encrypted(key, [3, 4, 7]));
            const usePolicies = read(organization, "usePolicies");
            policyContexts.set(id, {
              enabled,
              ...(typeof usePolicies === "boolean" ? { usePolicies } : {}),
              role: read(organization, "type"),
              status,
              providerUser: providerOrganizationIds.has(id),
            });
          }
          const policiesNew = sync.policiesNew ?? [];
          const uriMatchContext = createBitwardenUriMatchContext(
            sync.domains,
            // Pinned clients fall back to `policies` when `policiesNew` is absent or empty.
            uriMatchDefault(policiesNew.length ? policiesNew : sync.policies, policyContexts),
          );
          const ciphers: Sdk.Cipher[] = [];
          const unavailableItems: PreparedBitwardenAccount["unavailableItems"] = [];
          const itemIds = new Set<string>();
          for (const raw of list(sync.ciphers)) {
            const item = record(raw);
            const id = identifier(read(item, "id"));
            if (itemIds.has(id)) reject();
            itemIds.add(id);
            const type = integer(read(item, "type"));
            if (type > 4) {
              for (const name of ["organizationId", "folderId"])
                if (read(item, name) != null) identifier(read(item, name));
              unavailableItems.push({ itemId: id, reason: "unsupported-cipher-type" });
              continue;
            }
            const cipher = cipherDto(item, type, id);
            if (
              cipher.organizationId &&
              !organizations.has(cipher.organizationId as unknown as string)
            )
              reject();
            ciphers.push(cipher);
          }
          const encryptedMetadata = v.safeParse(encryptedCatalogContextSchema, {
            folders: list(sync.folders).map((folderInput) => {
              const folder = record(folderInput);
              return {
                id: identifier(read(folder, "id")),
                name: encrypted(read(folder, "name")),
                revisionDate: requiredText(read(folder, "revisionDate")),
              };
            }),
            collections: list(sync.collections).map((collectionInput) => {
              const collection = record(collectionInput);
              const organizationId = identifier(read(collection, "organizationId"));
              if (!organizations.has(organizationId)) reject();
              return {
                id: identifier(read(collection, "id")),
                organizationId,
                name: encrypted(read(collection, "name")),
                externalId: optionalCollectionText(read(collection, "externalId")),
                hidePasswords:
                  read(collection, "hidePasswords") == null
                    ? false
                    : boolean(read(collection, "hidePasswords")),
                readOnly:
                  read(collection, "readOnly") == null
                    ? false
                    : boolean(read(collection, "readOnly")),
                manage:
                  read(collection, "manage") == null ? false : boolean(read(collection, "manage")),
                defaultUserCollectionEmail: optionalCollectionText(
                  read(collection, "defaultUserCollectionEmail"),
                ),
                // SharedCollection is 0 and DefaultUserCollection is 1.
                type: collectionType(read(collection, "type")),
              };
            }),
          });
          if (
            !encryptedMetadata.success ||
            new Set(
              [...encryptedMetadata.output.folders, ...encryptedMetadata.output.collections].map(
                (group) => group.id.toLowerCase(),
              ),
            ).size !==
              encryptedMetadata.output.folders.length + encryptedMetadata.output.collections.length
          )
            reject();
          return {
            ok: true,
            data: {
              binding: { profile: profile.data, userId, email: actualEmail, accountVersion },
              accountCryptographicState: cryptographicState,
              kdf: unlock.kdf,
              masterPasswordUnlock: unlock,
              organizationKeys: [...organizations].map(([organizationId, key]) => ({
                organizationId,
                key,
              })),
              ciphers,
              unavailableItems,
              minimumSecurityVersion: binding.kind === "known" ? binding.minimumSecurityVersion : 1,
              coverage: "received-envelope",
              encryptedMetadata: encryptedMetadata.output,
              uriMatchContext,
            },
          };
        } catch (error) {
          if (error instanceof AdmissionFailure && error.check) return mismatch(error.check);
          return failure(error instanceof AdmissionFailure ? error.code : "invalid-response");
        }
      },
    }),
  };
}

