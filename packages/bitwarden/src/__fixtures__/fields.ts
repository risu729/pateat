// Synthetic decrypted views for local permission/reference tests. These are
// not cryptographic known answers; the integration test also uses real SDK output.
export const fieldConnectionId = "synthetic-fields";
export const fieldUserId = "00000000-0000-0000-0000-000000000001";
export const fieldItemId = "00000000-0000-0000-0000-000000000002";
export const fieldSnapshotId = "00000000-0000-0000-0000-000000000003";
export const nextFieldSnapshotId = "00000000-0000-0000-0000-000000000004";
export const customFieldId = (ordinal: number, snapshotId = fieldSnapshotId) =>
  `custom.${snapshotId}.${ordinal}`;

export function localLoginView() {
  return {
    id: fieldItemId,
    type: 1,
    name: "Synthetic login",
    notes: "Local note",
    viewPassword: true,
    login: { username: "00001234", password: "Synthetic-password", totp: null },
    fields: [
      { name: "duplicate", value: "007", type: 0, linkedId: null },
      { name: "duplicate", value: "00001234", type: 1, linkedId: null },
      { name: "checkbox", value: "false", type: 2, linkedId: null },
      { name: "linked-password", value: "ignored stored alias value", type: 3, linkedId: 101 },
    ],
  };
}

export function localCardView() {
  return {
    ...localLoginView(),
    type: 3,
    login: null,
    card: {
      cardholderName: "Synthetic Owner",
      expMonth: "01",
      expYear: "2030",
      code: "007",
      brand: "Visa",
      number: "00001234",
    },
    fields: [],
  };
}

export function localIdentityView() {
  return {
    ...localLoginView(),
    type: 4,
    login: null,
    identity: {
      title: "Dr",
      firstName: "Ada",
      middleName: "M",
      lastName: "Example",
      address1: "1 Example Lane",
      address2: "Apartment 007",
      address3: "Building A",
      city: "Example City",
      state: "Example State",
      postalCode: "0001",
      country: "AU",
      company: "Synthetic Company",
      email: "synthetic@example.test",
      phone: "00001234",
      ssn: "00001234",
      username: "00001234",
      passportNumber: "00001234",
      licenseNumber: "00001234",
    },
    fields: [],
  };
}
