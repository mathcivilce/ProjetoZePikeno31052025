import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";
import { Client } from "npm:@microsoft/microsoft-graph-client";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BATCH_SIZE = 10;
const PAGE_SIZE = 15;
const RETRY_DELAY = 2000;
const MAX_RETRIES = 5;

async function retryOperation<T>(
  operation: () => Promise<T>,
  retries = MAX_RETRIES,
  delay = RETRY_DELAY
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (retries > 0 && (error.statusCode === 429 || error.statusCode >= 500)) {
      console.log(`Retrying operation, ${retries} attempts remaining`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryOperation(operation, retries - 1, delay * 2);
    }
    throw error;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { storeId } = await req.json();
    
    if (!storeId) {
      throw new Error('Store ID is required');
    }

    console.log(`Processing sync request for store: ${storeId}`);

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

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', storeId)
      .single();

    if (storeError) {
      console.error('Store fetch error:', storeError);
      throw new Error(`Store not found: ${storeError.message}`);
    }

    if (!store) {
      throw new Error('Store not found');
    }

    if (!store.access_token) {
      throw new Error('Store has no access token');
    }

    const { data: latestEmail, error: emailError } = await supabase
      .from('emails')
      .select('date')
      .eq('store_id', storeId)
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (emailError && emailError.code !== 'PGRST116') {
      throw emailError;
    }

    const syncFrom = latestEmail
      ? new Date(latestEmail.date)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    const filter = `receivedDateTime gt ${syncFrom.toISOString()}`;
    console.log(`Fetching emails since ${syncFrom.toISOString()}`);

    const graphClient = Client.init({
      authProvider: (done) => {
        done(null, store.access_token);
      }
    });

    try {
      console.log('Testing Microsoft Graph API token...');
      await retryOperation(() => graphClient.api('/me').get());
      console.log('Token validation successful');
    } catch (error) {
      console.error('Token validation failed:', {
        status: error.statusCode,
        message: error.message,
        body: error.body
      });
      
      await supabase
        .from('stores')
        .update({ 
          status: 'issue',
          connected: false,
          last_synced: new Date().toISOString()
        })
        .eq('id', storeId);
        
      throw new Error(`Invalid or expired access token: ${error.message}`);
    }

    let allEmails = [];
    let nextLink = null;
    let pageCount = 0;
    
    do {
      try {
        pageCount++;
        console.log(`Fetching page ${pageCount}...`);

        let response;
        if (nextLink) {
          console.log('Fetching next page from:', nextLink);
          const fetchResponse = await retryOperation(() => 
            fetch(nextLink, {
              headers: {
                'Authorization': `Bearer ${store.access_token}`,
                'Content-Type': 'application/json'
              }
            })
          );

          if (!fetchResponse.ok) {
            throw new Error(`HTTP error! status: ${fetchResponse.status}`);
          }

          response = await fetchResponse.json();
        } else {
          console.log('Fetching first page from Graph API...');
          response = await retryOperation(() => 
            graphClient
              .api('/me/messages')
              .filter(filter)
              .select('id,subject,bodyPreview,from,receivedDateTime,isRead,body,conversationId,internetMessageId,parentFolderId')
              .orderby('receivedDateTime desc')
              .top(PAGE_SIZE)
              .get()
          );
        }

        if (!response || !Array.isArray(response.value)) {
          console.error('Invalid response format:', response);
          throw new Error('Invalid response format from Microsoft Graph API');
        }

        // Process emails in smaller chunks with longer delays
        for (const email of response.value) {
          if (email.conversationId) {
            try {
              const conversationResponse = await retryOperation(() =>
                graphClient
                  .api(`/me/messages`)
                  .filter(`conversationId eq '${email.conversationId}'`)
                  .select('id,subject,bodyPreview,from,receivedDateTime,isRead,body,conversationId,internetMessageId,parentFolderId')
                  .orderby('receivedDateTime asc')
                  .top(PAGE_SIZE)
                  .get()
              );

              if (conversationResponse && Array.isArray(conversationResponse.value)) {
                const newMessages = conversationResponse.value.filter(
                  msg => !allEmails.some(e => e.id === msg.id)
                );
                allEmails.push(...newMessages);
              }
            } catch (convError) {
              console.error(`Error fetching conversation ${email.conversationId}:`, convError);
              allEmails.push(email);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            allEmails.push(email);
          }
        }

        nextLink = response['@odata.nextLink'];
        console.log(`Retrieved ${response.value.length} emails on page ${pageCount}`);

        if (nextLink) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error) {
        console.error('Error fetching emails:', {
          page: pageCount,
          status: error.statusCode || error.status,
          message: error.message,
          body: error.body
        });

        if (error.statusCode === 429 || (error.response && error.response.status === 429)) {
          const retryAfter = parseInt(error.headers?.get('Retry-After') || '60');
          console.log(`Rate limited, waiting ${retryAfter} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }

        console.log('Stopping pagination due to error, will process collected emails');
        nextLink = null;
      }
    } while (nextLink);

    console.log(`Total emails to process: ${allEmails.length}`);

    if (allEmails.length > 0) {
      const emailsToSave = allEmails.map((msg: any) => ({
        id: crypto.randomUUID(),
        graph_id: msg.id,
        thread_id: msg.conversationId,
        parent_id: null,
        subject: msg.subject || 'No Subject',
        from: msg.from?.emailAddress?.address || '',
        snippet: msg.bodyPreview || '',
        content: msg.body?.content || '',
        date: msg.receivedDateTime || new Date().toISOString(),
        read: msg.isRead || false,
        priority: 1,
        status: 'open',
        store_id: storeId,
        user_id: store.user_id,
        internet_message_id: msg.internetMessageId
      }));

      let savedCount = 0;

      for (let i = 0; i < emailsToSave.length; i += BATCH_SIZE) {
        const batch = emailsToSave.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(emailsToSave.length / BATCH_SIZE);
        
        console.log(`Saving batch ${batchNumber} of ${totalBatches}`);

        try {
          await retryOperation(async () => {
            const { error: saveError } = await supabase
              .from('emails')
              .upsert(batch, {
                onConflict: 'graph_id,user_id',
                ignoreDuplicates: false
              });

            if (saveError) throw saveError;
          });

          savedCount += batch.length;
          console.log(`Successfully saved ${savedCount} of ${emailsToSave.length} emails`);

          if (i + BATCH_SIZE < emailsToSave.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } catch (error) {
          console.error(`Error saving batch ${batchNumber}:`, error);
          continue;
        }
      }
    }

    const { error: updateError } = await supabase
      .from('stores')
      .update({ 
        last_synced: new Date().toISOString(),
        status: 'active',
        connected: true
      })
      .eq('id', storeId);

    if (updateError) throw updateError;

    console.log('Sync completed successfully');

    return new Response(
      JSON.stringify({ 
        success: true,
        emailsProcessed: allEmails.length,
        lastSynced: new Date().toISOString()
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in sync function:', {
      message: error.message,
      stack: error.stack,
      cause: error.cause
    });

    return new Response(
      JSON.stringify({ 
        error: error.message,
        details: error.cause ? String(error.cause) : undefined
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      }
    );
  }
});