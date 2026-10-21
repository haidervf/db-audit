import type { ReactNode } from 'react';

/** Fix hints for known refresh warnings / errors (matched on the server's message text). */
export function hintFor(message: string): ReactNode | null {
  const m = message.toLowerCase();
  if (m.includes('agent jobs not readable') || m.includes('sqlagentreaderrole'))
    return (
      <>
        In msdb: <code>ALTER ROLE SQLAgentReaderRole ADD MEMBER [user];</code> (add the login to SQLAgentReaderRole in msdb)
      </>
    );
  if (m.includes('sql_expression_dependencies'))
    return (
      <>
        In the target database: <code>GRANT SELECT ON sys.sql_expression_dependencies TO [user];</code>
      </>
    );
  if (m.includes('null definition')) {
    const hidden = /(\d+)\s+not visible/.exec(m);
    if (hidden && Number(hidden[1]) > 0)
      return (
        <>
          In the target database: <code>GRANT VIEW DEFINITION TO [user];</code>
        </>
      );
    return <>Encrypted modules (WITH ENCRYPTION) have no readable definition; they cannot be analyzed. Nothing to fix in db-audit.</>;
  }
  if (/[1-9]\d* not visible/.test(m) || (m.includes('view definition') && !m.includes('encrypted')))
    return (
      <>
        In the target database: <code>GRANT VIEW DEFINITION TO [user];</code>
      </>
    );
  if (m.includes('view database state') || m.includes('dm_db_partition_stats'))
    return (
      <>
        Optional, for exact row counts and sizes: <code>GRANT VIEW DATABASE STATE TO [user];</code>
      </>
    );
  if (m.includes('jobs_reader') || (m.includes('elastic') && m.includes('permission')))
    return (
      <>
        In the Elastic Jobs database: <code>ALTER ROLE jobs_reader ADD MEMBER [user];</code>
      </>
    );
  if (m.includes('encrypted')) return <>Encrypted modules (WITH ENCRYPTION) have no readable definition; they cannot be analyzed.</>;
  if (m.includes('stale module') || m.includes('binding error'))
    return <>The module references a column or object that no longer exists; it would fail when executed. Fix or drop it.</>;
  if (m.includes('deferred name resolution') || m.includes('do not exist'))
    return <>These modules reference objects that are missing in this database (or are created at run time). Check for typos or dropped objects.</>;
  if (m.includes('login failed')) return <>Check the user name and password (or the Entra account) for this connection.</>;
  if (m.includes('az login') || m.includes('azure cli')) return <>Run <code>az login</code> in a terminal on this machine, then retry.</>;
  return null;
}

export interface PermissionInfo {
  key: 'viewDefinition' | 'expressionDependencies' | 'viewDatabaseState' | 'agentJobs' | 'jobsViews';
  label: string;
  required: boolean;
  fix: ReactNode;
  impact: string;
}

export const TARGET_PERMISSIONS: PermissionInfo[] = [
  {
    key: 'viewDefinition',
    label: 'VIEW DEFINITION',
    required: true,
    fix: <code>GRANT VIEW DEFINITION TO [user];</code>,
    impact: 'Required: object definitions and metadata.',
  },
  {
    key: 'expressionDependencies',
    label: 'SELECT on sys.sql_expression_dependencies',
    required: true,
    fix: <code>GRANT SELECT ON sys.sql_expression_dependencies TO [user];</code>,
    impact: 'Without it table-level dependencies are missing (only sys.dm_sql_referenced_entities is used).',
  },
  {
    key: 'viewDatabaseState',
    label: 'VIEW DATABASE STATE',
    required: false,
    fix: <code>GRANT VIEW DATABASE STATE TO [user];</code>,
    impact: 'Optional: exact row counts and table sizes.',
  },
  {
    key: 'agentJobs',
    label: 'SQL Agent jobs (msdb)',
    required: false,
    fix: (
      <>
        <code>USE msdb; ALTER ROLE SQLAgentReaderRole ADD MEMBER [user];</code> — add to SQLAgentReaderRole in msdb
      </>
    ),
    impact: 'Needed to read SQL Agent jobs, steps, schedules and history.',
  },
];

export const JOBS_PERMISSIONS: PermissionInfo[] = [
  {
    key: 'jobsViews',
    label: 'Elastic Jobs views (schema jobs)',
    required: true,
    fix: <code>ALTER ROLE jobs_reader ADD MEMBER [user];</code>,
    impact: 'Needed to read Elastic Jobs, steps, target groups and executions.',
  },
];
