import React, { createContext, useContext, useState, useEffect } from 'react';
import { PublicClientApplication, InteractionRequiredAuthError, Configuration, AccountInfo } from '@azure/msal-browser';
import { Client } from '@microsoft/microsoft-graph-client';
import { Message } from '@microsoft/microsoft-graph-types';
import { createClient } from '@supabase/supabase-js';
import toast from 'react-hot-toast';
import { useAuth } from './AuthContext';

interface Email {
  id: string;
  graph_id?: string;
  subject: string;
  snippet: string;
  content?: string;
  from: string;
  date: string;
  read: boolean;
  priority: number;
  status: string;
  storeName: string;
  storeColor: string;
  store_id: string;
  thread_id?: string;
}

interface Store {
  id: string;
  name: string;
  platform: 'outlook' | 'gmail';
  email: string;
  connected: boolean;
  status: 'active' | 'issue' | 'pending' | 'syncing';
  color: string;
  lastSynced?: string;
  access_token?: string;
}

interface InboxContextType {
  emails: Email[];
  stores: Store[];
  getEmailById: (id: string) => Email | undefined;
  markAsRead: (id: string) => void;
  deleteEmail: (id: string) => Promise<void>;
  statuses: string[];
  connectStore: (storeData: any) => Promise<void>;
  disconnectStore: (id: string) => void;
  syncEmails: (storeId: string) => Promise<void>;
  loading: boolean;
  error: string | null;
  pendingStore: any | null;
}

const InboxContext = createContext<InboxContextType | undefined>(undefined);

export const useInbox = () => {
  const context = useContext(InboxContext);
  if (context === undefined) {
    throw new Error('useInbox must be used within an InboxProvider');
  }
  return context;
};

const requiredScopes = [
  'User.Read',
  'Mail.Read',
  'Mail.ReadBasic',
  'offline_access'
];

const msalConfig: Configuration = {
  auth: {
    clientId: import.meta.env.VITE_AZURE_CLIENT_ID || '',
    authority: 'https://login.microsoftonline.com/common',
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
    navigateToLoginRequestUrl: true
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: true
  },
  system: {
    allowNativeBroker: false,
    windowHashTimeout: 60000,
    iframeHashTimeout: 6000,
    loadFrameTimeout: 0,
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        switch (level) {
          case 0: console.error(message); break;
          case 1: console.warn(message); break;
          case 2: console.info(message); break;
          case 3: console.debug(message); break;
        }
      },
      piiLoggingEnabled: false
    }
  }
};

let msalInstance: PublicClientApplication | null = null;

const initializeMsal = async () => {
  if (!msalInstance) {
    if (!import.meta.env.VITE_AZURE_CLIENT_ID) {
      throw new Error('Azure Client ID is not configured');
    }
    msalInstance = new PublicClientApplication(msalConfig);
    await msalInstance.initialize();
  }
  return msalInstance;
};

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const InboxProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [emails, setEmails] = useState<Email[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [pendingStore, setPendingStore] = useState<any | null>(null);
  const [currentAccount, setCurrentAccount] = useState<AccountInfo | null>(null);
  const [realtimeSubscription, setRealtimeSubscription] = useState<any>(null);
  
  const statuses = ['open', 'pending', 'resolved'];

  const getEmailById = (id: string) => {
    return emails.find(email => email.id === id);
  };

  const markAsRead = async (id: string) => {
    try {
      const { error: updateError } = await supabase
        .from('emails')
        .update({ read: true })
        .eq('id', id);

      if (updateError) throw updateError;

      setEmails(prev => prev.map(email => 
        email.id === id ? { ...email, read: true } : email
      ));
    } catch (error) {
      console.error('Error marking email as read:', error);
      setError('Failed to mark email as read');
    }
  };

  const deleteEmail = async (id: string) => {
    try {
      const { error: deleteError } = await supabase
        .from('emails')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;

      setEmails(prev => prev.filter(email => email.id !== id));
    } catch (error) {
      console.error('Error deleting email:', error);
      setError('Failed to delete email');
    }
  };

  const connectStore = async (storeData: any) => {
    try {
      setLoading(true);
      setPendingStore(storeData);

      const msalInstance = await initializeMsal();
      const loginRequest = {
        scopes: [...requiredScopes, 'Mail.Send', 'Mail.ReadWrite'],
        prompt: 'select_account'
      };

      const msalResponse = await msalInstance.loginPopup(loginRequest);
      setCurrentAccount(msalResponse.account);

      const tokenResponse = await msalInstance.acquireTokenSilent({
        scopes: [...requiredScopes, 'Mail.Send', 'Mail.ReadWrite'],
        account: msalResponse.account
      });

      const { data: store, error: storeError } = await supabase
        .from('stores')
        .insert({
          name: storeData.name,
          platform: 'outlook',
          email: msalResponse.account.username,
          color: storeData.color || '#2563eb',
          connected: true,
          status: 'active',
          user_id: user?.id,
          access_token: tokenResponse.accessToken
        })
        .select()
        .single();

      if (storeError) throw storeError;

      // Create webhook subscription
      const graphClient = Client.init({
        authProvider: (done) => {
          done(null, tokenResponse.accessToken);
        }
      });

      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 3);

      const clientState = crypto.randomUUID();

      const subscription = await graphClient
        .api('/subscriptions')
        .post({
          changeType: 'created',
          notificationUrl: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/email-webhook`,
          resource: '/me/mailFolders(\'Inbox\')/messages',
          expirationDateTime: expirationDate.toISOString(),
          clientState
        });

      const { error: subError } = await supabase
        .from('graph_subscriptions')
        .insert({
          store_id: store.id,
          subscription_id: subscription.id,
          resource: subscription.resource,
          client_state: clientState,
          expiration_date: subscription.expirationDateTime
        });

      if (subError) throw subError;

      setStores(prev => [...prev, store]);
      setPendingStore(null);

      // Initial email backfill
      const syncFrom = new Date();
      syncFrom.setDate(syncFrom.getDate() - 7);

      const { data: syncResult, error: syncError } = await supabase.functions.invoke('sync-emails', {
        body: { 
          storeId: store.id,
          syncFrom: syncFrom.toISOString(),
          syncTo: new Date().toISOString()
        }
      });

      if (syncError) throw syncError;

      toast.success('Store connected and initial sync completed');
    } catch (err) {
      console.error('Error connecting store:', err);
      toast.error('Failed to connect store');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const disconnectStore = async (id: string) => {
    try {
      const store = stores.find(s => s.id === id);
      if (!store) return;

      // Get webhook subscription
      const { data: subscription } = await supabase
        .from('graph_subscriptions')
        .select('subscription_id')
        .eq('store_id', id)
        .single();

      if (subscription) {
        try {
          // Try to delete the webhook subscription
          const graphClient = Client.init({
            authProvider: (done) => {
              done(null, store.access_token);
            }
          });

          await graphClient
            .api(`/subscriptions/${subscription.subscription_id}`)
            .delete()
            .catch(async (error) => {
              // If token expired, try to refresh it
              if (error.statusCode === 401) {
                const msalInstance = await initializeMsal();
                const accounts = msalInstance.getAllAccounts();
                
                const account = accounts.find(a => 
                  a.username.toLowerCase() === store.email.toLowerCase()
                );

                if (account) {
                  try {
                    const response = await msalInstance.acquireTokenSilent({
                      scopes: requiredScopes,
                      account
                    });

                    // Retry deletion with new token
                    const newClient = Client.init({
                      authProvider: (done) => {
                        done(null, response.accessToken);
                      }
                    });

                    await newClient
                      .api(`/subscriptions/${subscription.subscription_id}`)
                      .delete();
                  } catch (tokenError) {
                    // Ignore token errors, proceed with store deletion
                    console.warn('Failed to refresh token:', tokenError);
                  }
                }
              }
            });

          // Delete subscription record
          await supabase
            .from('graph_subscriptions')
            .delete()
            .eq('store_id', id);
        } catch (webhookError) {
          // Log but continue with store deletion
          console.warn('Error cleaning up webhook:', webhookError);
        }
      }

      // Delete store and related data
      const { error: deleteError } = await supabase
        .from('stores')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;

      // Update local state
      setStores(prev => prev.filter(store => store.id !== id));
      setEmails(prev => prev.filter(email => email.store_id !== id));

      toast.success('Store disconnected successfully');
    } catch (error) {
      console.error('Error disconnecting store:', error);
      toast.error('Failed to disconnect store');
      throw error;
    }
  };

  const syncEmails = async (storeId: string) => {
    try {
      const { data: response } = await supabase.functions.invoke('sync-emails', {
        body: { storeId }
      });

      if (response.error) throw new Error(response.error);

      toast.success('Email sync completed successfully');
    } catch (error) {
      console.error('Error syncing emails:', error);
      toast.error('Failed to sync emails');
    }
  };

  useEffect(() => {
    const init = async () => {
      if (!import.meta.env.VITE_AZURE_CLIENT_ID) {
        setError('Microsoft authentication is not configured');
        setLoading(false);
        return;
      }

      try {
        await initializeMsal();
        setInitialized(true);
      } catch (err) {
        console.error('Failed to initialize MSAL:', err);
        setError('Failed to initialize Microsoft authentication');
      } finally {
        setLoading(false);
      }
    };
    init();
  }, []);

  useEffect(() => {
    if (!user) return;

    const loadData = async () => {
      try {
        console.log('InboxContext: Starting data load for user:', user.id);
        
        const { data: storesData, error: storesError } = await supabase
          .from('stores')
          .select('*')
          .eq('user_id', user.id);

        console.log('InboxContext: Stores query result:', { storesData, storesError });
        
        if (storesError) {
          console.error('InboxContext: Stores error:', storesError);
          throw storesError;
        }

        const { data: emailsData, error: emailsError } = await supabase
          .from('emails')
          .select('*')
          .eq('user_id', user.id);

        console.log('InboxContext: Emails query result:', { emailsData: emailsData?.length, emailsError });

        if (emailsError) {
          console.error('InboxContext: Emails error:', emailsError);
          throw emailsError;
        }

        console.log('InboxContext: Setting stores and emails data');
        setStores(storesData || []);
        setEmails((emailsData || []).map(email => {
          const store = storesData?.find(s => s.id === email.store_id);
          return {
            ...email,
            storeName: store?.name || '',
            storeColor: store?.color || '#2563eb'
          };
        }));
        
        console.log('InboxContext: Data loaded successfully');
      } catch (err) {
        console.error('InboxContext: Error loading data:', err);
        setError('Failed to load data: ' + (err as any)?.message);
      } finally {
        setLoading(false);
      }
    };

    loadData();

    // Set up realtime subscription
    const subscription = supabase
      .channel('emails')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'emails',
        },
        async (payload) => {
          const newEmail = payload.new;

          if (newEmail.user_id === user.id) {
            const store = stores.find(s => s.id === newEmail.store_id);
            
            const emailWithStore = {
              ...newEmail,
              storeName: store?.name || '',
              storeColor: store?.color || '#2563eb'
            };

            const exists = emails.some(e => e.graph_id === newEmail.graph_id);
            if (!exists) {
              setEmails(prev => [emailWithStore, ...prev]);
              toast.success(`New email from ${newEmail.from}`);
            }
          }
        }
      )
      .subscribe();

    setRealtimeSubscription(subscription);

    return () => {
      if (realtimeSubscription) {
        supabase.removeChannel(realtimeSubscription);
      }
    };
  }, [user]);

  const value = {
    emails,
    stores,
    getEmailById,
    markAsRead,
    deleteEmail,
    statuses,
    connectStore,
    disconnectStore,
    syncEmails,
    loading,
    error,
    pendingStore
  };

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
};