const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
  console.warn("Supabase ainda não configurado completamente.");
}

const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

module.exports = { supabase };
