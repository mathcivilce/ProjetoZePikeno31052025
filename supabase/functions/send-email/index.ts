import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js';
import { Client } from 'npm:@microsoft/microsoft-graph-client';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { emailId, content } = await req.json();
    
    // Get auth token from request header
    const authHeader = req.headers.get('Authorization')?.split('Bearer ')[1];
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    // Initialize Supabase client with service role key to bypass RLS
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    // Get the email details and user info
    const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader);
    if (userError || !user) {
      throw new Error('Failed to get user information');
    }

    const { data: email, error: emailError } = await supabase
      .from('emails')
      .select(`
        *,
        store:stores (*)
      `)
      .eq('id', emailId)
      .single();

    if (emailError) throw emailError;
    if (!email) throw new Error('Email not found');

    // Initialize Microsoft Graph client with the store's access token
    const graphClient = Client.init({
      authProvider: (done) => {
        done(null, email.store.access_token);
      }
    });

    // Create reply email
    const reply = {
      message: {
        subject: `Re: ${email.subject}`,
        body: {
          contentType: 'HTML',
          content
        },
        toRecipients: [{
          emailAddress: {
            address: email.from
          }
        }]
      }
    };

    // Send the reply
    const response = await graphClient
      .api(`/me/messages/${email.graph_id}/reply`)
      .post(reply);

    // Get the message ID from the response
    const messageId = response.id;

    // Save the reply in the database
    const { data: savedReply, error: replyError } = await supabase
      .from('email_replies')
      .insert({
        email_id: email.id,
        user_id: user.id,
        store_id: email.store_id,
        graph_id: messageId,
        content,
        sent_at: new Date().toISOString()
      })
      .select()
      .single();

    if (replyError) throw replyError;

    // Update email status
    const { error: updateError } = await supabase
      .from('emails')
      .update({ 
        status: 'resolved',
        thread_id: email.thread_id || email.graph_id // Use existing thread_id or original message ID
      })
      .eq('id', emailId);

    if (updateError) throw updateError;

    return new Response(
      JSON.stringify({ success: true, data: savedReply }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error sending email:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      }
    );
  }
});