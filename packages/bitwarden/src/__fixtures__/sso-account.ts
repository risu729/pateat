// Fixed public synthetic DTOs for the packaged SSO flow. All ciphertexts use the
// existing upstream V1 user key, independent Node AES-256-CBC/HMAC-SHA256 and IV
// 000102030405060708090a0b0c0d0e0f. No test runtime encryptor or decryption mock.
import { rawLoginCipher, rawV1Account, syntheticJwt } from "./account";
import { fidoCredential, legacyPassword, legacyUsername } from "./crypto";

export const syntheticSsoOrigins = {
  rp: "https://rp.synthetic.example.test",
  idp: "https://idp.synthetic.example.test",
} as const;
export const syntheticSsoItemIds = {
  rp: "10000000-0000-4000-8000-000000000085",
  idp: "10000000-0000-4000-8000-000000000086",
  decoy: "10000000-0000-4000-8000-000000000087",
} as const;
const encrypted = {
  rpName:
    "2.AAECAwQFBgcICQoLDA0ODw==|T7099rJvCQeSA0tRmcbel3eWy3r9Ih8VP8pTRJjevBU=|a7TjIgF4yIHF4QsgqkHplejfnu09OFbNNj07qyWJLvo=",
  idpName:
    "2.AAECAwQFBgcICQoLDA0ODw==|ifsFo/qcM2LBMVUt+LRLOg==|8Q7bp/1JLZ2KXEeI9+59xSZnR711liyDk9JOVLgD3Lw=",
  decoyName:
    "2.AAECAwQFBgcICQoLDA0ODw==|1e/RtrPe7RAZwpQWjiUBEhfZdPY5q0IwmEDy1bHzeH0=|fLSIuZD5wzcUmHbJ5zp07ERjF3eIZ/c538nA86bE6Y0=",
  rpUsername:
    "2.AAECAwQFBgcICQoLDA0ODw==|Sz7gN82QI0PhGmsAclC4jg==|6BVmsgpp/9ruWjRcEUpaW/CXLisdXV8tPReDDxJwJZk=",
  decoyUsername:
    "2.AAECAwQFBgcICQoLDA0ODw==|cp1vZdkr0/ix34lXaegxTQ==|QNtSv3FJIlsN4UMHUi5Mq22zh+LCuCyPlYUbEQddONw=",
  fieldName:
    "2.AAECAwQFBgcICQoLDA0ODw==|CKv0Jkc+u9E1o5PszSr9Bw==|HUml63FSN9DAK1TlA7y7HpvJxDn2yCY6utRys/NcalY=",
  fieldValue:
    "2.AAECAwQFBgcICQoLDA0ODw==|YuLHUMR950+L/fK52wimgu7VoqXn0cXAoAKR/KMn0sM=|+FloH1Ewi0pqdNP57pCFJyg1li3EnEPLswzrcvJbURc=",
  rpUri:
    "2.AAECAwQFBgcICQoLDA0ODw==|4SgkadEh8pJqksZOm81sJClxrIExNlrk1PVb0Ifg1CF5XLM3BQ2G9K6vJZ4E+DhT|gcC2dY6iOVoWw/S/TU8u+3upuRoSpjwulObbenO8be0=",
  idpUri:
    "2.AAECAwQFBgcICQoLDA0ODw==|+cONUfjd0ESWt+PxPzGR6rvetmSC9A+iKO0F45LxdIFOcy0WiJszW92BVp5tpPjb|/+AONlJG9d43C/93LDKKZv8+QZ2WgeBZGIO27uzqwo4=",
  rpChecksum:
    "2.AAECAwQFBgcICQoLDA0ODw==|T7cRNKTY933323jqhzN1aFrDkznGaJUM9an6JNwH6DT6vvDP1w8+Hx97e6PVNjs+|ZDV03iDgEvA3m5wAgOGcMjmAnjeYhuRuebmEXtqmZs8=",
  idpChecksum:
    "2.AAECAwQFBgcICQoLDA0ODw==|I649m0wOxgQmYIZWdsSmR8WQxSJ1HF8I9DHcsOK77LcXUPS47M/wYzniz6o2bOVk|7Pa5AvAqvkZ9QpCLZ3z22QkUO58PDnHxyfc8fFGdgCc=",
} as const;

const idpPasskeyRpId =
  "2.AAECAwQFBgcICQoLDA0ODw==|CyQImCJPY0OCwPiO/ye3IqvEG1MGU/h8c4gVdfXAn/E=|3Im1BpIhqFqbrhEJs/QDB4GCmSY2kAEpRGsu9G7R6M8=";

const siblingUri = {
  uri: "2.AAECAwQFBgcICQoLDA0ODw==|5xq+IyItJI2K8q6V1LoPcubvSmEHw+5v1Cf5gbAh+Nen9vowxDtUUI1BVpewyVvF+QyZEI9P3o40UvUpBUviig==|XGbmkKF4fcayTCOYOFAQeW8A8mZRvqp14pH2RE2iemQ=",
  uriChecksum:
    "2.AAECAwQFBgcICQoLDA0ODw==|dYvR5OkmQ9Vh9mvf7AwvAFvZYSkdXVafzYBTLNCswh2Jr5ba/ckp89yRlie2w1Bm|eWCutZRODhug/n/C0KB7+h2BPk+bN3FWhkC4866IL74=",
  match: 1,
};

export function rawSsoAccount(
  exactUri: boolean,
  nowSeconds: number,
  passkey = false,
  sibling = false,
) {
  const raw = rawV1Account();
  const item = (kind: keyof typeof syntheticSsoItemIds) => {
    const source = rawLoginCipher();
    const rp = kind === "rp";
    const username = rp
      ? encrypted.rpUsername
      : kind === "idp"
        ? legacyUsername
        : encrypted.decoyUsername;
    const password = rp ? null : legacyPassword;
    const name = rp ? encrypted.rpName : kind === "idp" ? encrypted.idpName : encrypted.decoyName;
    const fields = rp
      ? [{ name: encrypted.fieldName, value: encrypted.fieldValue, type: 0, linkedId: null }]
      : [];
    const uris: { uri: string; uriChecksum: string; match: number }[] = [
      {
        uri: rp ? encrypted.rpUri : encrypted.idpUri,
        uriChecksum: rp ? encrypted.rpChecksum : encrypted.idpChecksum,
        // Host matching permits the ordinary flow; exact mode checks the path fence.
        match: exactUri && !rp ? 3 : 1,
      },
    ];
    if (sibling && kind === "idp") uris.push(siblingUri);
    const login = {
      ...source.login,
      username,
      password,
      uris,
      fido2Credentials:
        passkey && kind === "idp" ? [{ ...fidoCredential, rpId: idpPasskeyRpId }] : null,
    };
    return {
      ...source,
      id: syntheticSsoItemIds[kind],
      name,
      login,
      fields,
      data: JSON.stringify({
        ...JSON.parse(source.data),
        name,
        username,
        password,
        uris,
        fields,
        fido2Credentials: login.fido2Credentials,
      }),
    };
  };
  return {
    token: {
      ...raw.token,
      access_token: syntheticJwt({
        iat: nowSeconds - 1,
        nbf: nowSeconds - 1,
        exp: nowSeconds + 3600,
      }),
    },
    sync: { ...raw.sync, ciphers: [item("rp"), item("idp"), item("decoy")] },
  };
}
