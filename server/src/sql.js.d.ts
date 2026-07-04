declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export interface Database {
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    close(): void;
  }

  export default function initSqlJs(config?: unknown): Promise<SqlJsStatic>;
}
