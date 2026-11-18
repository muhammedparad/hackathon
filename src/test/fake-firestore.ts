// TEST FIXTURE ONLY: a tiny in-memory stand-in for the Firebase Admin Firestore, covering the calls the
// device ingest routes make (equality `where`, add/doc/set/update/get, batches). Not used by the app.
type Doc = Record<string, unknown>;

export class FakeFirestore {
  private store = new Map<string, Map<string, Doc>>();
  private counter = 0;

  nextId(): string {
    return `auto_${++this.counter}`;
  }

  rows(name: string): Map<string, Doc> {
    let m = this.store.get(name);
    if (!m) {
      m = new Map();
      this.store.set(name, m);
    }
    return m;
  }

  /** All documents of a collection as `{ id, ...fields }` (for assertions). */
  all(name: string): Array<Doc & { id: string }> {
    return [...this.rows(name).entries()].map(([id, d]) => ({ id, ...d }));
  }

  seed(name: string, id: string, doc: Doc): void {
    this.rows(name).set(id, { ...doc });
  }

  reset(): void {
    this.store.clear();
    this.counter = 0;
  }

  collection(name: string): FakeQuery {
    return new FakeQuery(this, name, []);
  }

  batch() {
    const ops: Array<() => void> = [];
    return {
      set: (ref: FakeDocRef, doc: Doc, opts?: { merge?: boolean }) => {
        ops.push(() => ref.write(doc, opts));
      },
      commit: async () => {
        ops.forEach((op) => op());
      },
    };
  }
}

export class FakeDocRef {
  constructor(
    private db: FakeFirestore,
    readonly collectionName: string,
    readonly id: string,
  ) {}

  write(doc: Doc, opts?: { merge?: boolean }): void {
    const rows = this.db.rows(this.collectionName);
    rows.set(this.id, opts?.merge ? { ...(rows.get(this.id) ?? {}), ...doc } : { ...doc });
  }

  async set(doc: Doc, opts?: { merge?: boolean }): Promise<void> {
    this.write(doc, opts);
  }

  async update(updates: Doc): Promise<void> {
    const rows = this.db.rows(this.collectionName);
    if (!rows.has(this.id))
      throw new Error(`No document to update: ${this.collectionName}/${this.id}`);
    rows.set(this.id, { ...rows.get(this.id), ...updates });
  }

  async get(): Promise<FakeDocSnap> {
    return new FakeDocSnap(this, this.db.rows(this.collectionName).get(this.id));
  }
}

export class FakeDocSnap {
  constructor(
    readonly ref: FakeDocRef,
    private doc: Doc | undefined,
  ) {}
  get id(): string {
    return this.ref.id;
  }
  get exists(): boolean {
    return this.doc !== undefined;
  }
  data(): Doc | undefined {
    return this.doc ? { ...this.doc } : undefined;
  }
}

export class FakeQuery {
  constructor(
    private db: FakeFirestore,
    private name: string,
    private filters: Array<[string, unknown]>,
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== "==") throw new Error(`FakeFirestore supports only '==' (got '${op}')`);
    return new FakeQuery(this.db, this.name, [...this.filters, [field, value]]);
  }

  limit(): FakeQuery {
    return this;
  }

  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.db, this.name, id ?? this.db.nextId());
  }

  async add(doc: Doc): Promise<FakeDocRef> {
    const ref = this.doc();
    ref.write(doc);
    return ref;
  }

  async get(): Promise<{ empty: boolean; docs: FakeDocSnap[] }> {
    const docs = [...this.db.rows(this.name).entries()]
      .filter(([, d]) => this.filters.every(([f, v]) => d[f] === v))
      .map(([id, d]) => new FakeDocSnap(new FakeDocRef(this.db, this.name, id), d));
    return { empty: docs.length === 0, docs };
  }
}

/** One shared instance; the test mocks the Admin module to hand this out. */
export const fakeDb = new FakeFirestore();
