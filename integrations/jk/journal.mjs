import { PixConnectorError } from './vendor/connectors/banking/validation.mjs';

/** Shares the 0.2.1 async store; never opens a second database or runs DDL. */
export class AsyncPixChargeJournal {
  constructor(db) { this.db = db; }
  async reserve(charge) {
    try {
      const changed = await this.db.prepare(`INSERT INTO jk_pix_journal(scope,txid,fingerprint,amount_cents,order_id,created_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(scope,txid) DO NOTHING`)
        .run(charge.scope, charge.txid, charge.fingerprint, charge.amountCents, charge.orderId, new Date().toISOString());
      if (Number(changed.changes) === 1) return 'NEW';
      const previous = await this.find(charge.scope, charge.txid);
      return previous?.fingerprint === charge.fingerprint && previous.amountCents === charge.amountCents && previous.orderId === charge.orderId ? 'EXISTING' : 'CONFLICT';
    } catch { throw new PixConnectorError('JOURNAL_UNAVAILABLE', 'REJECTED'); }
  }
  async find(scope, txid) {
    try {
      const row = await this.db.prepare('SELECT * FROM jk_pix_journal WHERE scope=? AND txid=?').get(scope, txid);
      return row ? { scope: row.scope, txid: row.txid, fingerprint: row.fingerprint, amountCents: row.amount_cents, orderId: row.order_id } : undefined;
    } catch { throw new PixConnectorError('JOURNAL_UNAVAILABLE', 'REJECTED'); }
  }
}
