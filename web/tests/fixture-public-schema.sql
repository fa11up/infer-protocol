-- imdusd-public: the PUBLIC history index read by imdusd.com's /api/v1. Raw on-chain logs only, nothing private:
-- this database is bound to a public Worker. Never add a table here that is not derived from public chain data.
CREATE TABLE logs (
  address TEXT NOT NULL,          -- lowercase 0x address of the emitting contract
  block_number INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,          -- lowercase
  tx_index INTEGER,
  block_hash TEXT,
  block_time INTEGER,             -- unix seconds
  topic0 TEXT,
  topic1 TEXT,
  topic2 TEXT,
  topic3 TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (block_number, log_index)
) WITHOUT ROWID;
CREATE INDEX logs_address_block ON logs (address, block_number, log_index);
CREATE INDEX logs_topic1_block ON logs (topic1, block_number);

-- through = last block fully indexed (every source); unverified = a reconciliation mismatch is open (JSON) or absent.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
