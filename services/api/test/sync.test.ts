import { registerDeviceAuthenticationTests, registerSettingsSyncTests } from "./sync/settings";
import { registerRecipeSyncTests, registerOwnerLimitTests } from "./sync/recipes";
import { registerLoginOutcomeTests, registerLoginRecordTests } from "./sync/login-reports";
import { registerRecipeRevocationTests } from "./sync/revocation";
import { registerRecipeMigrationTests } from "./sync/migration";
import { registerEntryBlockTests } from "./sync/entry-blocks";

registerDeviceAuthenticationTests();
registerSettingsSyncTests();
registerRecipeSyncTests();
registerOwnerLimitTests();
registerLoginOutcomeTests();
registerLoginRecordTests();
registerRecipeRevocationTests();
registerRecipeMigrationTests();
registerEntryBlockTests();
