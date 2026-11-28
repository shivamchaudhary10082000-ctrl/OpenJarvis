-- Optional capability requirements for NEO task scheduling.
ALTER TABLE task_leases
  ADD COLUMN required_capabilities_json TEXT NOT NULL DEFAULT '[]';
