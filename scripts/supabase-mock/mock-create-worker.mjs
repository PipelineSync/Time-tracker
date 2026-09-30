// In-memory stand-in for netlify/functions/lib/supabase.ts, just big enough for
// netlify/functions/create-worker.ts: an admin auth client (createUser /
// deleteUser) and a `workers` / `profiles` table that records every insert the
// function attempts. `kpiRoleColumnMissing` makes the `workers` table reject a
// row that names `kpi_role`, the way PostgREST does on a database that has not
// run supabase/RUN-THIS-kpi-role.sql.
export const state = {
  capabilityChecked: null,
  authUsers: [],
  deletedAuthUsers: [],
  workerInserts: [], // every row the function tried to insert, in order
  workers: [],
  profiles: [],
  kpiRoleColumnMissing: false,
}

export function resetState() {
  state.capabilityChecked = null
  state.authUsers = []
  state.deletedAuthUsers = []
  state.workerInserts = []
  state.workers = []
  state.profiles = []
  state.kpiRoleColumnMissing = false
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const sb = {
  auth: {
    admin: {
      createUser: async ({ email }) => {
        const user = { id: `auth-${state.authUsers.length + 1}`, email }
        state.authUsers.push(user)
        return { data: { user }, error: null }
      },
      deleteUser: async (id) => {
        state.deletedAuthUsers.push(id)
        return { data: null, error: null }
      },
    },
  },
  from(table) {
    return {
      insert(row) {
        const result = () => {
          if (table === 'workers') {
            state.workerInserts.push({ ...row })
            if (state.kpiRoleColumnMissing && 'kpi_role' in row) {
              return { data: null, error: { message: "Could not find the 'kpi_role' column of 'workers' in the schema cache" } }
            }
            const worker = { id: `w-${state.workers.length + 1}`, ...row }
            state.workers.push(worker)
            return { data: worker, error: null }
          }
          state.profiles.push({ ...row })
          return { data: row, error: null }
        }
        return {
          select: () => ({ single: async () => result() }),
          then: (resolve) => resolve({ error: result().error }),
        }
      },
      delete: () => ({
        eq: async (col, val) => {
          if (table === 'workers') state.workers = state.workers.filter((w) => w[col] !== val)
          return { error: null }
        },
      }),
    }
  },
}

export async function requireCapability(_request, capability) {
  state.capabilityChecked = capability
  return { sb, ownerId: 'owner-1' }
}
