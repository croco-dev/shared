export interface TxAdapter<TClient, TOptions = unknown> {
  /**
   * The signal marks the transaction deadline. An adapter that cancels safely must finish rollback
   * and reject with `TransactionRollbackConfirmedProblem` whose cause is `signal.reason`. Once this
   * promise fulfills, TxManager treats the transaction as committed even if the signal fired while
   * the adapter was waiting for the commit response.
   */
  transaction<T>(
    fn: (client: TClient) => Promise<T>,
    options?: TOptions,
    signal?: AbortSignal,
  ): Promise<T>;

  /**
   * The signal follows the same commit-aware boundary as transaction(): finish rollback and reject
   * with `TransactionRollbackConfirmedProblem` before release, or fulfill after release completes.
   */
  savepoint<T>(
    client: TClient,
    fn: (client: TClient) => Promise<T>,
    options?: TOptions,
    signal?: AbortSignal,
  ): Promise<T>;

  /** Check the active transaction client when capability depends on the driver or connection. */
  supportsSavepoint(client?: TClient): boolean;
}
