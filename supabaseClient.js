import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://vaclsmbrthfrojjbvifr.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhY2xzbWJydGhmcm9qamJ2aWZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1OTkxNzUsImV4cCI6MjA3MzE3NTE3NX0.kuchfBJWQvbFIb2N_V1rsDmtr3k4d93HBuZOgygq89Q";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
