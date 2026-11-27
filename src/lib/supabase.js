import { createClient } from '@supabase/supabase-js'

// In dev without a .env (the fixture session, src/dev/fixture.js), a
// placeholder keeps createClient from throwing at import. Production builds
// take the real values only.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || (import.meta.env.DEV ? 'http://localhost:54321' : undefined)
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || (import.meta.env.DEV ? 'dev-placeholder-key' : undefined)

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
