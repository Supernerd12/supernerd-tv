-- Scheduled emails: authenticate to dynamic-processor with a shared secret from Vault.
-- (It used to send the public page key, which the function rejects — so nothing was delivered.)
create or replace function public.dispatch_scheduled_emails()
 returns void language plpgsql security definer set search_path = public as $function$
declare r record; v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'DISPATCH_SECRET' limit 1;
  if v_secret is null then return; end if;
  for r in
    select * from scheduled_emails where status = 'scheduled' and send_at <= now() order by send_at limit 25
  loop
    perform net.http_post(
      url := 'https://wvtokocjhtpjrkojxaia.supabase.co/functions/v1/dynamic-processor',
      headers := jsonb_build_object('Content-Type','application/json','x-dispatch-secret', v_secret,
                                    'apikey','sb_publishable_NOSa5I95dUTHZhVai9dZtQ_8GEM00J6'),
      body := jsonb_build_object('to', to_jsonb(r.to_emails), 'bcc', to_jsonb(r.bcc_emails),
                                 'subject', r.subject, 'html', r.html, 'replyTo', r.reply_to)
    );
    update scheduled_emails set status = 'sent', sent_at = now() where id = r.id;
  end loop;
end;
$function$;
