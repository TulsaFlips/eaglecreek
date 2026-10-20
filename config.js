// The Supabase project this copy of Eagle Creek uses, so the sign-in screen asks only for a
// username (or email) and password. Both values are public by design: the project URL and its
// publishable (anon) key. What keeps the books private is the database's row-level security
// (supabase/setup.sql) and new sign-ups being turned off in Supabase. Never put the secret or
// service_role key here.
//
// Left blank, the sign-in screen asks for the URL and key (or a setup link) as before.
const BUILT_IN_PROJECT = {
  url: 'https://jyylfwjfsqgypwabuswq.supabase.co',
  key: 'sb_publishable_g4F1JqIWKsi1Yb0eUYZ5_w_IMGO6TBZ',
};
