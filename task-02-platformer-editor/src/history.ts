export class History<T> {
  private past: T[] = []
  private future: T[] = []
  private present: T
  private checkpoint: T | null = null

  constructor(
    initial: T,
    private readonly limit: number,
    private readonly clone: (value: T) => T,
    private readonly same: (a: T, b: T) => boolean,
  ) {
    if (limit < 20) throw new Error('撤销栈至少保留 20 步')
    this.present = clone(initial)
  }

  current(): T {
    return this.present
  }

  get undoSteps(): number {
    return this.past.length
  }

  get redoSteps(): number {
    return this.future.length
  }

  get stroking(): boolean {
    return this.checkpoint !== null
  }

  begin(): void {
    if (this.checkpoint) return
    this.checkpoint = this.clone(this.present)
  }

  end(): void {
    if (!this.checkpoint) return
    const before = this.checkpoint
    this.checkpoint = null
    if (this.same(before, this.present)) return
    this.pushPast(before)
    this.future = []
  }

  cancel(): void {
    if (!this.checkpoint) return
    this.present = this.checkpoint
    this.checkpoint = null
  }

  commit(next: T): void {
    if (this.checkpoint) this.end()
    if (this.same(this.present, next)) return
    this.pushPast(this.clone(this.present))
    this.present = this.clone(next)
    this.future = []
  }

  undo(): boolean {
    if (this.checkpoint) this.end()
    const previous = this.past.pop()
    if (!previous) return false
    this.future.push(this.clone(this.present))
    this.present = previous
    return true
  }

  redo(): boolean {
    if (this.checkpoint) this.end()
    const next = this.future.pop()
    if (!next) return false
    this.pushPast(this.clone(this.present))
    this.present = next
    return true
  }

  private pushPast(snapshot: T): void {
    this.past.push(snapshot)
    if (this.past.length > this.limit) this.past.shift()
  }
}
