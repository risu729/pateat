// Synthetic fixtures recorded by the official SDK at 7de8f13a14b56068167160f88d55231f916cf16a.
// GPL-3.0 upstream source. Paths below resolve against this immutable source tree:
// https://github.com/bitwarden/sdk-internal/tree/7de8f13a14b56068167160f88d55231f916cf16a
// These are public test vectors, never values read from a real account.

// crates/bitwarden-wasm-internal/integration-tests/tests/utils.ts
export const v1Email = "test@bitwarden.com";
export const v1Password = "asdfasdfasdf";
export const v1Kdf = { pBKDF2: { iterations: 100_000 } } as const;
// crates/bitwarden-crypto/src/keys/kdf.rs
export const kdfPassword = "67t9b5g67$%Dh89n";
export const kdfSalt = "test_key";
export const pbkdf2Expected = [
  31, 79, 104, 226, 150, 71, 177, 90, 194, 80, 172, 209, 17, 129, 132, 81, 138, 167, 69, 167, 254,
  149, 2, 27, 39, 197, 64, 42, 22, 195, 86, 75,
];
export const argon2Expected = [
  207, 240, 225, 177, 162, 19, 163, 76, 98, 106, 179, 175, 224, 9, 17, 240, 20, 147, 237, 47, 246,
  150, 141, 184, 62, 225, 131, 242, 51, 53, 225, 242,
];
// crates/bitwarden-vault/src/cipher/cipher.rs, test_decrypt_cipher_list_view.
export const legacyItemKey =
  "w2LO+nwV4oxwswVYCxlOfRUseXfvU03VzvKQHrqeklPgiMZrspUe6sOBToCnDn9Ay0tuCBn8ykVVRb7PWhub2Q==";
export const legacyName =
  "2.d3rzo0P8rxV9Hs1m1BmAjw==|JOwna6i0zs+K7ZghwrZRuw==|SJqKreLag1ID+g6H1OdmQr0T5zTrVWKzD6hGy3fDqB0=";
export const legacyUsername =
  "2.EBNGgnaMHeO/kYnI3A0jiA==|9YXlrgABP71ebZ5umurCJQ==|GDk5jxiqTYaU7e2AStCFGX+a1kgCIk8j0NEli7Jn0L4=";
export const legacyPassword =
  "2.M7ZJ7EuFDXCq66gDTIyRIg==|B1V+jroo6+m/dpHx6g8DxA==|PIXPBCwyJ1ady36a7jbcLg346pm/7N/06W4UZxc1TUo=";

export function legacyCipher() {
  return {
    id: "090c19ea-a61a-4df6-8963-262b97bc6266",
    organizationId: null,
    folderId: null,
    collectionIds: [],
    key: null,
    name: legacyName,
    notes: null,
    type: 1,
    login: {
      username: legacyUsername,
      password: legacyPassword,
      passwordRevisionDate: null,
      uris: null,
      totp: null,
      autofillOnPageLoad: null,
      fido2Credentials: null,
    },
    identity: null,
    card: null,
    secureNote: null,
    sshKey: null,
    bankAccount: null,
    driversLicense: null,
    passport: null,
    favorite: false,
    reprompt: 0,
    organizationUseTotp: false,
    edit: true,
    permissions: null,
    viewPassword: true,
    localData: null,
    attachments: null,
    fields: null,
    passwordHistory: null,
    creationDate: "2024-01-30T17:55:36.150Z",
    deletedDate: null,
    revisionDate: "2024-01-30T17:55:36.150Z",
    archivedDate: null,
    data: null,
  };
}
export const v1PrivateKey =
  "2.kmLY8NJVuiKBFJtNd/ZFpA==|qOodlRXER+9ogCe3yOibRHmUcSNvjSKhdDuztLlucs10jLiNoVVVAc+9KfNErLSpx5wmUF1hBOJM8zwVPjgQTrmnNf/wuDpwiaCxNYb/0v4FygPy7ccAHK94xP1lfqq7U9+tv+/yiZSwgcT+xF0wFpoxQeNdNRFzPTuD9o4134n8bzacD9DV/WjcrXfRjbBCzzuUGj1e78+A7BWN7/5IWLz87KWk8G7O/W4+8PtEzlwkru6Wd1xO19GYU18oArCWCNoegSmcGn7w7NDEXlwD403oY8Oa7ylnbqGE28PVJx+HLPNIdSC6YKXeIOMnVs7Mctd/wXC93zGxAWD6ooTCzHSPVV50zKJmWIG2cVVUS7j35H3rGDtUHLI+ASXMEux9REZB8CdVOZMzp2wYeiOpggebJy6MKOZqPT1R3X0fqF2dHtRFPXrNsVr1Qt6bS9qTyO4ag1/BCvXF3P1uJEsI812BFAne3cYHy5bIOxuozPfipJrTb5WH35bxhElqwT3y/o/6JWOGg3HLDun31YmiZ2HScAsUAcEkA4hhoTNnqy4O2s3yVbCcR7jF7NLsbQc0MDTbnjxTdI4VnqUIn8s2c9hIJy/j80pmO9Bjxp+LQ9a2hUkfHgFhgHxZUVaeGVth8zG2kkgGdrp5VHhxMVFfvB26Ka6q6qE/UcS2lONSv+4T8niVRJz57qwctj8MNOkA3PTEfe/DP/LKMefke31YfT0xogHsLhDkx+mS8FCc01HReTjKLktk/Jh9mXwC5oKwueWWwlxI935ecn+3I2kAuOfMsgPLkoEBlwgiREC1pM7VVX1x8WmzIQVQTHd4iwnX96QewYckGRfNYWz/zwvWnjWlfcg8kRSe+68EHOGeRtC5r27fWLqRc0HNcjwpgHkI/b6czerCe8+07TWql4keJxJxhBYj3iOH7r9ZS8ck51XnOb8tGL1isimAJXodYGzakwktqHAD7MZhS+P02O+6jrg7d+yPC2ZCuS/3TOplYOCHQIhnZtR87PXTUwr83zfOwAwCyv6KP84JUQ45+DItrXLap7nOVZKQ5QxYIlbThAO6eima6Zu5XHfqGPMNWv0bLf5+vAjIa5np5DJrSwz9no/hj6CUh0iyI+SJq4RGI60lKtypMvF6MR3nHLEHOycRUQbZIyTHWl4QQLdHzuwN9lv10ouTEvNr6sFflAX2yb6w3hlCo7oBytH3rJekjb3IIOzBpeTPIejxzVlh0N9OT5MZdh4sNKYHUoWJ8mnfjdM+L4j5Q2Kgk/XiGDgEebkUxiEOQUdVpePF5uSCE+TPav/9FIRGXGiFn6NJMaU7aBsDTFBLloffFLYDpd8/bTwoSvifkj7buwLYM+h/qcnfdy5FWau1cKav+Blq/ZC0qBpo658RTC8ZtseAFDgXoQZuksM10hpP9bzD04Bx30xTGX81QbaSTNwSEEVrOtIhbDrj9OI43KH4O6zLzK+t30QxAv5zjk10RZ4+5SAdYndIlld9Y62opCfPDzRy3ubdve4ZEchpIKWTQvIxq3T5ogOhGaWBVYnkMtM2GVqvWV//46gET5SH/MdcwhACUcZ9kCpMnWH9CyyUwYvTT3UlNyV+DlS27LMPvaw7tx7qa+GfNCoCBd8S4esZpQYK/WReiS8=|pc7qpD42wxyXemdNPuwxbh8iIaryrBPu8f/DGwYdHTw=";
export const v1WrappedUserKey =
  "2.u2HDQ/nH2J7f5tYHctZx6Q==|NnUKODz8TPycWJA5svexe1wJIz2VexvLbZh2RDfhj5VI3wP8ZkR0Vicvdv7oJRyLI1GyaZDBCf9CTBunRTYUk39DbZl42Rb+Xmzds02EQhc=|rwuo5wgqvTJf3rgwOUfabUyzqhguMYb3sGBjOYqjevc=";

// crates/bitwarden-wasm-internal/integration-tests/tests/v2-fixtures.ts
export const v2Kdf = { argon2id: { iterations: 6, memory: 32, parallelism: 4 } } as const;
export const V2_PRIVATE_KEY =
  "7.g1gdowE6AAEReQMZARwEULFmQoUOmnvQ/mZY+Y6N/fGhBVgYe16rmgYXX3Orgo6y5U5Z8eb+JHTGfcivWQTR+1rVWtHJhEm8G/AtE78Ud3S8qxZmstUKhC5u9xgPvx2e8Fe8QL80Dv0WoEsy0XEb+5EFd8xDlu7OBuCVv2MaoJ/XzAkbpn9IT1vMCPhvRuaktIWMNrQgJ1jnmqjTGObftA02sHnj938tLRNfilw8ln/PBO2GBZQVzTUYfnc+mBeedGyZAxhSxyUwtFB8h3HC/t9BGtLT/bm83Df8rwTc+rGFL5r+T6vczQ+6hvF6kKpUb37XwgLEDsc+J4UTb+4zHaDcTioOYq6Hki8PrsN9PWL57nkhRMi3fKgfz8GDtY+pjp7D9HYV6OMuveSK9l+h16enJwiFDy6XEx+eth4aHPT5hybnOfTWbkEIhUmPD3K2JKvUUxeL9Z6e1EtSylVitO4Lit485KYaY8VASW4MnAzPOUQVwZ4jowHr5X8g0jVtHiLeUuOwDGcqjO/q6//tkiCwjW/W79jk4eqMtqPbOl0XelYVmM4KZCslPZ+2IYS56g/gl8Q2Oj9UGq7QJCsZvV9rBNa4wS3uC9atoWWRqO2PTWkVTurakkK3Fc9VP2bC1lJaWoWVjYpyJJVZh77ktpD3VrFdrT62+de0iaWUAtAr/1ALToNzoTYu3ihyGb6FZMN//XLTKk8GhZGVCluEDClHnziBxCX7Qg/0HRiU7EjsYGhpFnmG2XkvZQb9Pds8gucTbmbUeVfjXZ/IOLm16G/tdit2VIf80zcsvhgxTYys4Cm12N+62fM3aT5L9lqWvBYOMDksy00/3uLPzWbLFWbKItaC1c+bceGS7UDrLim6Pm/Voo2jXCi6EHpXX2/THrJybRDwqmQi7UVWXR3aPx//q9busEXxRyeu0m4lq2AjhQWhOvfPjpJzNX1hRE9Bu7UKYJhUF6DAsXFFKpob0LoARpcjGLFLcO61yV6He2nQFAa+ULXxhrKbISzqO3Q2xMs2p3jQ4Ctm0T+03w9Y5/Yf1qNKaL6AayA2nf0thYgh+OHNEnnkFwvBnTyB5B32E+/cUy7bb3329Pz7h+ruLo5IhGZM5GiEjF4vOSZmZJZ1t2eR4U7oxX0VTpwFPPBUQ3O7A5C2l0g/pGCFda4QlgR5qRA09kaAd9VBSJbQABGH0zWlXNPAjPQ6M9CxxTv9lM/72RSzTvnJqjQNpWGQjYuTi++EN5QZ37Nmlcw9eSa6X1C97ADndWV46dlFowUUDXiczi+Q0bZmFtpvkRg0TWlicS/cURLIfpG7sGwgqIis5R4haQ+RDB1+4oC0xmncWqy7vMESW6trh+icEL2PybwGPnzdngUqEIw5fG9huX3BmxbJjukSjWWk2CH8AaY2lHRXttzpOhpfP9c1cmrwXXUuHwTFMiKdmdwSqGbgebUP25kB9priXO88Jri3Wb739KRV5M2k6/9AspCwpOqlKN6MZm2vElNI+cXSWMHeX3666p4ALr7Vu7+q7iw4s4cO09MMJWsaiTaZBsVRhdoocsej+091JM/yJ29TVDJEMp2vEiia8HQ4k2bH9W9XCB71cpygRMYTFRDJ3Yjly4MYg7whBQnkeu8IYagCY6UZ60V73qhKRZJKuiV6ZTC+objnMPMmi9Kd05WmYFab8ZDP8s4yhU0WJNXdZGwpX7pnoi0T+g/y94sfZNGs5QuKgNEX";
export const V2_SIGNING_KEY =
  "7.g1gcowE6AAEReQMYZQRQsWZChQ6ae9D+Zlj5jo398aEFWBj8Gg/gn4tQKWO3nq5e/2p9gkzIrKD829RYT3aEUIDOetEtnFqRuQ3Cz13693WqDnKHM5Buzi6LcTsxo1jphYR7vlE5nYLjCpOCAftPN1oLfs5SCNkwwMENhujpVftfDzciE99aLEJDS9A=";
export const V2_SECURITY_STATE =
  "hFgepAEnAxg8BFAmkP0QgfdMVbIujX55W/yNOgABOH8CoFgkomhlbnRpdHlJZFBHOOw2BI9OQoNq+Vl1xZZKZ3ZlcnNpb24CWEAlchbJR0vmRfShG8On7Q2gknjkw4Dd6MYBLiH4u+/CmfQdmjNZdf6kozgW/6NXyKVNu8dAsKsin+xxXkDyVZoG";
export const V2_SIGNED_PUBLIC_KEY =
  "hFgepAEnAxg8BFAmkP0QgfdMVbIujX55W/yNOgABOH8BoFkBTqNpYWxnb3JpdGhtAG1jb250ZW50Rm9ybWF0AGlwdWJsaWNLZXlZASYwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDP/7WM8nUepxoJ0qtM+azxcly+eZ31qUjjZTZcX/gYw1MzkoXWAjqyeFH/bdktq1lEUwegrxkIxKkY2SMtp0CvPnaV1x5O8E6FBSJbKWRlDg181rfEhgm5tc6aR4PJ827IvFVm9xk6Sj091P5DHZDEOsWLZc2jYjtpUV3X38I4gSR7HiYnR4DcwcWkoJ3FhtxMCwYgPz6RVH0vzhLUmm1mgbzH6IH8Pf9DjLTZSxBikVO7S9s9jzhiZbTeeAl3FbNLxfj9Qkj+NoSfms7jGVTlBwvSXgjJs/ktGkT1cR5QcBMpU4bt41+l73MN8pXapCih9Awf1W+RY7imxpYOMFJ3AgMBAAFYQMq/hT4wod2w8xyoM7D86ctuLNX4ZRo+jRHf2sZfaO7QsvonG/ZYuNKF5fq8wpxMRjfoMvnY2TTShbgzLrW8BA4=";
export const V2_DECRYPTED_USER_KEY =
  "pQEEAlCxZkKFDpp70P5mWPmOjf3xAzoAARF5BIQDBAUGIFggCFcd6XLISUfLaITyU9yimrYHacdS5XhBayO2663jdSUB";

// crates/bitwarden-vault/src/cipher/blob/sealed.rs
export const blobWrappingKey =
  "z27dMz/RK4wboY/Ako0YVFr9jaiSjgQQyGkTZ4LIuNrOXyeDAjeD41qbhVKl0OSjP3QuN9xmAJQE8+V5/Tl7ig==";
export const sealedBlob =
  '{"format_version":1,"wrapped_cek":"2.LQJf2BbznXX+NelBY4pSJg==|txMmjZEOhSMA7Jrm+rZt1LDfA6s3G2QU5Z8MqO4nG9s2ZXuzSLU/iYOUXD8xw+eHVSu7IUHu1LsCm4SLf+ZhkX5QIo4hJT3DHSbgu6VPUC0=|yuU/EWQWyihf2Yh9lQ1NP+zTROEpnXoRS//GfxDgC4k=","envelope":"g1hLpQE6AAERbwN4I2FwcGxpY2F0aW9uL3guYml0d2FyZGVuLmNib3ItcGFkZGVkBFBoHnjLne8MPV72YPXuskd6OgABOIECOgABOIABoQVYGA00vxb7gF7Y3SUyoCMy34C1HrB3fSY3jVhxZXQmmotGEIwwRlG+SpTcyTl5m4lUnozWrjAYfWitl1+cz457Wq3iDW/MvrHE7c1g38QJxY6t1yhQL0dQy9DyDXQDiWGPtYzic2Ay+GtrlIERN37wOdhQ1HZDeoobHL+aKomvPTems/Ta2SqWC9HfE38="}';

// Synthetic account adapters for the independently recorded item/blob vectors.
// Existing upstream test-only RSA DER rewrapped with Node AES256-CBC/HMAC-SHA256,
// fixed public IV 000102030405060708090a0b0c0d0e0f; generated outside SDK tests.
export const blobPrivateKey =
  "2.AAECAwQFBgcICQoLDA0ODw==|9Cz1JJrYECbxDrao/xCnbN/P/ZXCVc15mq8yQHmCxcSlP46s1LIMjTdaVCQtyKAZmEyDsoCIGv5/mlNXMc+rrqdrrJY29IsxWWPRjbQkQGrNeOvwT54Ymui2ck2Z3dn3/95qdPc8XnhKYZX9SZyyjboFMaC78tTAucdUNaDX8tfViDj/EI5Whie55c17WzAAK9oPFJfWcQVhXLSPWL0+BrbNkLn3SPJEge6VblJev3cP1TMGx/3PVf/F+YJY54RrlA486kLOzusH8FbudKfCRFw6/NUcokZPrbDEFnSr3fmPvME9PDU5IaJ/EdjD6BNZ/xUVuy52fM28/iGJhDaTeymhAKePMXER67Tht7mqSQKxHlMAxe3iHo3GRClEajyNySm+xisVgTtu2UcAu0gcyqqS0AZa6r4RrxRiP9BxbGRmZF8FN+Ev/mv0HrNIkx8iHIA3By7S1/QnGz8q2h2/+YKeF9rZV7njyNFmIM0cVqCTsA71hc2kiOstMRWosWLSjTVT+GR4Eu2EdDcUz+nbBdLxNKXXoesUfntsZySSmzyLP35zGcMK/NeTKS9/NHlhN0gvMg2f+CEdT3rg2DpnLMRzltdfc4GJ3mOgqRVjqHRQgdGwHw1zGrS25faD4C9csBoSnNdqNwJuHVvgELQY3jqlcAflSu2cCw8tjAZBxsbyLbPNaxBHWeEssdGrh3fu7CQh5MXWoJgQDRCwGlUYgsF5VjsAFnPhfkNPrHEBU5xE1qhOJyQUaQ4DT6KY48olbxrMuYWIrV1Uo4ck1JxeUZARpG3zQ6WS/TL/Flx+gxiL+6hwK9gUm5YpcmgWBUBN5HckoA6swRgI2o4MMsx0mgh+4su6a3j4tUqXLv+xR6TlyidFKGXrwiwlOv9h0p/SfQHGwTuCNZlMZkdHk9RG+nwYXTMbJclGkUrDopBIx1xqSuCiWGkvKQl0iyVvA3LpevItRl+z3VkIjL/9CtC565drl0SeocquusUuk+eO0kNiwVhJ0go8d7MV7LwYO7jptrc8OpTKdSYP1XZgOFV5oNLjFAhXViubesyVc8Rcgf/hi/41r8J3BBZXcZJ1AAE5Vzky0/LFotq1JKX0XR+R8u/ZwpIMt6JwqFnljrsWsCWv1QLpdGnYkEqwUumQ+4gqPs8WhFK+QMI3PFUuKLHoREqneMNx9QtvmokD4qYQG9WLsHTYIys0eY2IXlRiZx/oE+l9SXr7MPJdHrmuQgi4tPA3WmZxqROVBhUPuGCOkfyobldyhX5GE/vX1KrQW8822R3Bxv04ozybdCk1rh4CV1l73N3MYk6eSh7OjSeBekR7erJPF155XCbhhJjPTneD1ZEsyKBV0u9Mc9ijpf/dW2R2zMEY0NH8RH1CPIOrllMeHJ0+2u5uO7QrcCi3NXvo8YxziQb3MqwEqKlzhVCo1nLk8aErj95+sorWgkdcL+q8DIC9HoyNnY4rFRfyahi1kpWAynAHIn7Dw0rhF4ccVo+EczuxcqPJ6bHUVhzeLD83GZAy9SvrpM3SUVqU2xX0xSx720MDubD0KvxnpClqrEFDxcQTwgfEbcVprEaNTCYFca57GHNOQ7BO/PXkKAjnu06GZG4xlLoUa5HTOoeP87ISH5i/DfVoFqi4nnF/Dz4=|aro0+RJ6+IL/PCquOydzM/7b4Q14WxeE8kRncEIr0DI=";

// crates/bitwarden-wasm-internal/integration-tests/tests/org-fixtures.ts
export const ORG_ACCOUNT_MASTER_KEY_WRAPPED_USER_KEY =
  "2.Q/2PhzcC7GdeiMHhWguYAQ==|GpqzVdr0go0ug5cZh1n+uixeBC3oC90CIe0hd/HWA/pTRDZ8ane4fmsEIcuc8eMKUt55Y2q/fbNzsYu41YTZzzsJUSeqVjT8/iTQtgnNdpo=|dwI+uyvZ1h/iZ03VQ+/wrGEFYVewBUUl/syYgjsNMbE=";
export const ORG_ACCOUNT_PRIVATE_KEY =
  "2.yN7l00BOlUE0Sb0M//Q53w==|EwKG/BduQRQ33Izqc/ogoBROIoI5dmgrxSo82sgzgAMIBt3A2FZ9vPRMY+GWT85JiqytDitGR3TqwnFUBhKUpRRAq4x7rA6A1arHrFp5Tp1p21O3SfjtvB3quiOKbqWk6ZaU1Np9HwqwAecddFcB0YyBEiRX3VwF2pgpAdiPbSMuvo2qIgyob0CUoC/h4Bz1be7Qa7B0Xw9/fMKkB1LpOm925lzqosyMQM62YpMGkjMsbZz0uPopu32fxzDWSPr+kekNNyLt9InGhTpxLmq1go/pXR2uw5dfpXc5yuta7DB0EGBwnQ8Vl5HPdDooqOTD9I1jE0mRyuBpWTTI3FRnu3JUh3rIyGBJhUmHqGZvw2CKdqHCIrQeQkkEYqOeJRJVdBjhv5KGJifqT3BFRwX/YFJIChAQpebNQKXe/0kPivWokHWwXlDB7S7mBZzhaAPidZvnuIhalE2qmTypDwHy22FyqV58T8MGGMchcASDi/QXI6kcdpJzPXSeU9o+NC68QDlOIrMVxKFeE7w7PvVmAaxEo0YwmuAzzKy9QpdlK0aab/xEi8V4iXj4hGepqAvHkXIQd+r3FNeiLfllkb61p6WTjr5urcmDQMR94/wYoilpG5OlybHdbhsYHvIzYoLrC7fzl630gcO6t4nM24vdB6Ymg9BVpEgKRAxSbE62Tqacxqnz9AcmgItb48NiR/He3n3ydGjPYuKk/ihZMgEwAEZvSlNxYONSbYrIGDtOY+8Nbt6KiH3l06wjZW8tcmFeVlWv+tWotnTY9IqlAfvNVTjtsobqtQnvsiDjdEVtNy/s2ci5TH+NdZluca2OVEr91Wayxh70kpM6ib4UGbfdmGgCo74gtKvKSJU0rTHakQ5L9JlaSDD5FamBRyI0qfL43Ad9qOUZ8DaffDCyuaVyuqk7cz9HwmEmvWU3VQ+5t06n/5kRDXttcw8w+3qClEEdGo1KeENcnXCB32dQe3tDTFpuAIMLqwXs6FhpawfZ5kPYvLPczGWaqftIs/RXJ/EltGc0ugw2dmTLpoQhCqrcKEBDoYVk0LDZKsnzitOGdi9mOWse7Se8798ib1UsHFUjGzISEt6upestxOeupSTOh0v4+AjXbDzRUyogHww3V+Bqg71bkcMxtB+WM+pn1XNbVTyl9NR040nhP7KEf6e9ruXAtmrBC2ah5cFEpLIot77VFZ9ilLuitSz+7T8n1yAh1IEG6xxXxninAZIzi2qGbH69O5RSpOJuJTv17zTLJQIIc781JwQ2TTwTGnx5wZLbffhCasowJKd2EVcyMJyhz6ru0PvXWJ4hUdkARJs3Xu8dus9a86N8Xk6aAPzBDqzYb1vyFIfBxP0oO8xFHgd30Cgmz8UrSE3qeWRrF8ftrI6xQnFjHBGWD/JWSvd6YMcQED0aVuQkuNW9ST/DzQThPzRfPUoiL10yAmV7Ytu4fR3x2sF0Yfi87YhHFuCMpV/DsqxmUizyiJuD938eRcH8hzR/VO53Qo3UIsqOLcyXtTv6THjSlTopQ+JOLOnHm1w8dzYbLN44OG44rRsbihMUQp+wUZ6bsI8rrOnm9WErzkbQFbrfAINdoCiNa6cimYIjvvnMTaFWNymqY1vZxGztQiMiHiHYwTfwHTXrb9j0uPM=|09J28iXv9oWzYtzK2LBT6Yht4IT4MijEkk0fwFdrVQ4=";
export const TEST_ORGANIZATION_KEY =
  "4.rY01mZFXHOsBAg5Fq4gyXuklWfm6mQASm42DJpx05a+e2mmp+P5W6r54WU2hlREX0uoTxyP91bKKwickSPdCQQ58J45LXHdr9t2uzOYyjVzpzebFcdMw1eElR9W2DW8wEk9+mvtWvKwu7yTebzND+46y1nRMoFydi5zPVLSlJEf81qZZ4Uh1UUMLwXz+NRWfixnGXgq2wRq1bH0n3mqDhayiG4LJKgGdDjWXC8W8MMXDYx24SIJrJu9KiNEMprJE+XVF9nQVNijNAjlWBqkDpsfaWTUfeVLRLctfAqW1blsmIv4RQ91PupYJZDNc8nO9ZTF3TEVM+2KHoxzDJrLs2Q==";
export const TEST_ORGANIZATION_ID = "1bc9ac1e-f5aa-45f2-94bf-b181009709b8";

// Independent Node AES256-CBC/HMAC-SHA256 fixed-IV vectors, generated once.
// Organization key recovered from the upstream fixture with Node RSA-OAEP-SHA1.
export const organizationCipherFields = {
  name: "2.AAECAwQFBgcICQoLDA0ODw==|Iav9jGoAggL53CV88aHrIhBLxtdUs/KtBbAec6JiSOw=|cwxi1oQScdv9ga64u6jBkuXQze+P27Z3wUXnsYUjezU=",
  username:
    "2.AAECAwQFBgcICQoLDA0ODw==|V73n/2AYFDZW8UgQr10zT1/WfW8abX6Aer+zejEGFZU=|q/acz+7jFj4Sy1au56CFFp0Vxne2sclO83nQFZCqQlY=",
  password:
    "2.AAECAwQFBgcICQoLDA0ODw==|pw6WFZAfEqPbwkKGi1HTcxUfegCzBHbwznQebAubpWw=|bqGQEn1PVu9UY8y9G62vT02DMKit0f+woRxStmFQy/U=",
} as const;
export const customFieldCiphertexts = {
  duplicateName:
    "2.AAECAwQFBgcICQoLDA0ODw==|iB6uXoGP4ncOHS/xZwpJAw==|fbbRVr+gOTyHOIcQgNA9VacLUPaRQEtCY6oWsJUjRfw=",
  branch:
    "2.AAECAwQFBgcICQoLDA0ODw==|KYmpVjhmf1VRnnKD68QV3g==|ay3I+5la013OZz3tUTDl71Q8TBQOg4KCBsK6FVaSeAQ=",
  account:
    "2.AAECAwQFBgcICQoLDA0ODw==|a/eoRr+bEPZwRR4mJeb9oQ==|aCXyZEF4kqfdMX+jwUwnNVrD3uzkPrw4vjolawhDzv0=",
  boolean:
    "2.AAECAwQFBgcICQoLDA0ODw==|hJ6z6XnxqM/UTU5Osz78vg==|RXpmvR579fwex0KdJHnEAbyQzedLz1d4k4+3yJyAZKM=",
  linkedName:
    "2.AAECAwQFBgcICQoLDA0ODw==|31kNKoRDCPn9T6lu67Zfeg==|SK22l57aJzIjIUcvBoRvqga4V+BxAp+kCkQAbp6w4t0=",
} as const;
export const uriCiphertexts = {
  uri: "2.AAECAwQFBgcICQoLDA0ODw==|aCQDefY0N11l41vTeEbfKc2tYcLlaQ+oz+jaEuJc+dA1qhyIzqm3E2TiLp58JyXi|ZFHIsl/NBRbVqqNWczQn4fzNUoGu+N2A/upOBkiZ76Q=",
  checksum:
    "2.AAECAwQFBgcICQoLDA0ODw==|u8X3DFv5Ha2XUrnxMjGSmiyZRauTDsM0AkjJfspz1FahExlHfOiZv7Z5dBl7A6F8|2nXlJ3pgVoNHf0+TAeixRNTh4BZtfG8feafvHSmlX7o=",
  wrongChecksum:
    "2.AAECAwQFBgcICQoLDA0ODw==|VNsRO6s4lU+gJqwb1jVU6HkxkKscb8/+/HCcGZeMPOs=|ZBurW8nQVzrENMrvGkQV1nhYR6j/dSKEkyxi/U+bjYk=",
} as const;

// Synthetic P-256 PKCS8 generated locally with Node, stored only in this test fixture.
// Its fixed encrypted fields were constructed with Node AES/HMAC independently of SDK.
export const fidoPrivateKey =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgveEnqCTN3ltgBc+5Cqhc+VUoPIFmkuZNSfv1YBqg5F6hRANCAATmrsmnL8WlyQ4l1aAO8bOxRGqNazbjhU66rgf4Fg4YrMgaV22kOFxKRV4Ta4B1rgF3wCEiJYCrKrMNgDVkR6bd";
export const fidoCredential = {
  credentialId:
    "2.AAECAwQFBgcICQoLDA0ODw==|i/4lAExtWvA3HXwRee05gAIQbOY/mzYp2nA9XDukeDg+CWWTevzX7j+dfHBHE2Da|aQCqncXolxtTq9DAmT7ngeb5f/JIxXx3l/VHwfa69Qs=",
  keyType:
    "2.AAECAwQFBgcICQoLDA0ODw==|nkFvyvg4a6Z1YUg3IriI2g==|VVt2WSQjrqU/tHItL4BuKnMGPbHNb/qFraDpu13Tt0E=",
  keyAlgorithm:
    "2.AAECAwQFBgcICQoLDA0ODw==|pKuu1AESkBmdHxOmMKl+dQ==|FwmpYZT4mCyaCXmF0mOWRL0nQSHXfqr+oNEIdzO4zgk=",
  keyCurve:
    "2.AAECAwQFBgcICQoLDA0ODw==|bCfigUGV9V3+mb5oyOnCCw==|ChJj2rtuz0j6UGno2mCzw75IAoa6Hclr3G7bCsSWTFs=",
  keyValue:
    "2.AAECAwQFBgcICQoLDA0ODw==|cTI7+T5RyWFGKsHpeLs3XTpNvCURpOcxkJSNsEaVcfUALmdK4EfD+2SOm01R2nllCU2OEIxO+RA7gJnbyzAYMwK5B/v8ccrQGvpj64ahML+bWWb+41B21fGb3NmETA3w5+dRJFLYyLAfBcmycUu2kSQUDor6eAihBfjGYxWe7u7pIvQpxYqMNqH3he3mDC6xDK5ITEETRgKEG7TPfhN68eZTF3vRDn000ALPvSE+5b8Mi/9gH4d1PgWfgkoHcpqy|T7CGOuNnnQUBmOtQ8n0emCXpTBOCNCaUqvOOB/vrUOs=",
  rpId: "2.AAECAwQFBgcICQoLDA0ODw==|DffW05FND2NRUwfNbvfn/tbTjtcIPN1WIcV7a5A6drY=|4JtEOSxJYc2EvIgVP/NVzFnve19hSpaeLmWid8XxwTw=",
  userHandle:
    "2.AAECAwQFBgcICQoLDA0ODw==|nJKv+zMOJoudSLfE82jFfkeErwEK/uy1n1Eup58sFZM=|kCVKB0s0Wuix1NJ/WnVCu4BGlbEknjst4b0wK7fcZYw=",
  userName:
    "2.AAECAwQFBgcICQoLDA0ODw==|fo5G0C/7LM/rnrk2qqRiNA==|NT2p2FQRWcAcOALhmPA+w/V5501NbbqLI0tbemcxVaQ=",
  counter:
    "2.AAECAwQFBgcICQoLDA0ODw==|AkUWjs3VL3hOsK+PEx9YIQ==|6N3JsuqGCqAVzAZCCODLveuPIE8POdgN5pcbLDU4pTg=",
  rpName:
    "2.AAECAwQFBgcICQoLDA0ODw==|kDvEHwtsQHflUQX0R4bwYA==|Yvp9u7qmE312SN9omhIwxPZyuWXyTz3SAn0Koui0qew=",
  userDisplayName:
    "2.AAECAwQFBgcICQoLDA0ODw==|PKbWzi8dnUunf2fWnmWkQw==|tc9JiCY0eAEqWmbix75H8enxI7zTfJbD8dqiRxvvzco=",
  discoverable:
    "2.AAECAwQFBgcICQoLDA0ODw==|hJ6z6XnxqM/UTU5Osz78vg==|RXpmvR579fwex0KdJHnEAbyQzedLz1d4k4+3yJyAZKM=",
  creationDate: "2024-01-30T17:55:36.150Z",
} as const;

// Additional account adapter: pinned SDK wraps the fixed blob wrapping key for V2.
// This outer key-wrapper is SDK-generated; the payload/envelope/plaintext remain the
// independent recorded upstream sealed-blob vector, never encrypted in the test.
export const v2WrappedBlobKey =
  "7.g1g+owE6AAEReQN4ImFwcGxpY2F0aW9uL3guYml0d2FyZGVuLmxlZ2FjeS1rZXkEULFmQoUOmnvQ/mZY+Y6N/fGhBVgY7jUVegC0JcO/eYye0l1SGpQ5UepnPXgfWFBNj4Avp/lA7QQ58sX+diATSwWF6h1d2am9DRW0ZckhR2EL2ip3anyczeiUhFXykgUa/Hh/Q1LaJrGX2gPI7NzK+m5xZN6RrKpCVzQ92K6OIg==";
