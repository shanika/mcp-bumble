import type {
  Account,
  EnrichedTransaction,
  Paginated,
  Transaction,
  TransactionQueryParams,
} from "akahu";

import type { AkahuLike } from "../../src/akahu/client.js";

/** Two ANZ accounts and a Kiwibank loan — modelled loosely on the spec example. */
export const FIXTURE_ACCOUNTS: Account[] = [
  {
    _id: "acc_anz_go",
    _credentials: "creds_anz",
    connection: {
      _id: "conn_anz",
      name: "ANZ",
      logo: "",
    } as Account["connection"],
    name: "ANZ Shanika Go",
    type: "CHECKING",
    attributes: ["TRANSACTIONS", "TRANSFER_FROM", "TRANSFER_TO"],
    status: "ACTIVE",
    formatted_account: "01-1234-1234567-00",
    balance: { currency: "NZD", current: 1234.56, available: 1234.56 },
  },
  {
    _id: "acc_anz_savings",
    _credentials: "creds_anz",
    connection: {
      _id: "conn_anz",
      name: "ANZ",
      logo: "",
    } as Account["connection"],
    name: "ANZ Joint Savings",
    type: "SAVINGS",
    attributes: ["TRANSACTIONS", "TRANSFER_FROM", "TRANSFER_TO"],
    status: "ACTIVE",
    formatted_account: "01-1234-9876543-00",
    balance: { currency: "NZD", current: 5678.9, available: 5678.9 },
  },
  {
    _id: "acc_kiwi_loan",
    _credentials: "creds_kiwi",
    connection: {
      _id: "conn_kiwi",
      name: "Kiwibank",
      logo: "",
    } as Account["connection"],
    name: "Kiwibank Mortgage",
    type: "LOAN",
    attributes: ["TRANSACTIONS"],
    status: "ACTIVE",
    formatted_account: "38-9000-0000001-00",
    balance: { currency: "NZD", current: -312000 },
  },
];

interface TxOpts {
  id: string;
  account: string;
  date: string;
  amount: number;
  type: Transaction["type"];
  description: string;
  merchantName?: string;
  akahuCategory?: string;
  metaOtherAccount?: string;
}

export function makeTx(opts: TxOpts): EnrichedTransaction {
  const base = {
    _id: opts.id,
    _user: "user_test",
    _account: opts.account,
    _connection: "conn_test",
    created_at: opts.date,
    updated_at: opts.date,
    date: opts.date,
    hash: opts.id,
    description: opts.description,
    amount: opts.amount,
    type: opts.type,
  };
  return {
    ...base,
    merchant: opts.merchantName
      ? { _id: `m_${opts.id}`, name: opts.merchantName }
      : (undefined as unknown as EnrichedTransaction["merchant"]),
    category: opts.akahuCategory
      ? {
          _id: `c_${opts.id}`,
          name: opts.akahuCategory,
          groups: {},
        }
      : (undefined as unknown as EnrichedTransaction["category"]),
    meta: opts.metaOtherAccount
      ? { other_account: opts.metaOtherAccount }
      : ({} as EnrichedTransaction["meta"]),
  };
}

export interface StubAkahuOptions {
  accounts?: Account[];
  /** Pages of transactions to return in order. Each call to `list` consumes one. */
  transactionPages?: Transaction[][];
}

export interface StubAkahu extends AkahuLike {
  calls: {
    accounts: number;
    transactions: TransactionQueryParams[];
    refresh: { accountId: string }[];
    refreshAll: number;
  };
}

/** Lightweight stub of the Akahu SDK shape — no axios, no network. */
export function createStubAkahu(opts: StubAkahuOptions = {}): StubAkahu {
  const accounts = opts.accounts ?? FIXTURE_ACCOUNTS;
  const pages = (opts.transactionPages ?? [[]]).map((items, idx, arr) => ({
    items,
    cursor: { next: idx === arr.length - 1 ? null : `cursor_${idx + 1}` },
  })) as Paginated<Transaction>[];

  const calls = {
    accounts: 0,
    transactions: [] as TransactionQueryParams[],
    refresh: [] as { accountId: string }[],
    refreshAll: 0,
  };

  return {
    accounts: {
      list: async (_token: string) => {
        calls.accounts += 1;
        return accounts;
      },
      refresh: async (_token: string, accountId: string) => {
        calls.refresh.push({ accountId });
      },
      refreshAll: async (_token: string) => {
        calls.refreshAll += 1;
      },
    },
    transactions: {
      list: async (_token: string, query?: TransactionQueryParams) => {
        calls.transactions.push(query ?? {});
        if (query?.cursor) {
          const matched = pages.find(
            (p, idx) => idx > 0 && pages[idx - 1]?.cursor.next === query.cursor,
          );
          return matched ?? pages[pages.length - 1]!;
        }
        return pages[0] ?? { items: [], cursor: { next: null } };
      },
    },
    calls,
  };
}
