-- The settings revision of each device's last stored settings write, so a device whose
-- write got no answer learns whether it committed. Null until the device writes.
ALTER TABLE `devices` ADD `settings_revision` integer;
