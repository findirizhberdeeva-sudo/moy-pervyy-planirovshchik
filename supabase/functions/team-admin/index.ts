import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {createTeamAdminHandler} from './handler.mjs';
Deno.serve(createTeamAdminHandler({
 createClient,
 url:Deno.env.get('SUPABASE_URL'),
 publicKey:Deno.env.get('SUPABASE_ANON_KEY'),
 serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
 appUrl:Deno.env.get('RITM_APP_URL'),
 emailDeliveryEnabled:Deno.env.get('RITM_EMAIL_DELIVERY_ENABLED')==='true',
 allowedOrigins:(Deno.env.get('RITM_ALLOWED_ORIGINS')||'').split(',').map(value=>value.trim()).filter(Boolean)
}));
