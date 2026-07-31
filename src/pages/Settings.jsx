import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { connectGmail, syncGmailEmails } from '../lib/gmailSync'
import { timeAgo } from '../lib/formatters'

export default function Settings() {
  const [gmailStatus, setGmailStatus] = useState(null)
  const [lastSync, setLastSync] = useState(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const loadIntegrations = async () => {
    try {
      setIsLoading(true)
      const { data, error } = await supabase
        .from('integrations')
        .select('*')
        .eq('service', 'gmail')
        .single()
      
      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching integrations:', error)
      }
      
      if (data) {
        setGmailStatus(data.status)
        setLastSync(data.last_sync)
      } else {
        setGmailStatus('disconnected')
      }
    } catch (err) {
      console.error(err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadIntegrations()
  }, [])

  const handleConnect = async () => {
    await connectGmail(loadIntegrations)
    loadIntegrations()
  }

  const handleSync = async () => {
    setIsSyncing(true)
    await syncGmailEmails()
    await loadIntegrations()
    setIsSyncing(false)
  }

  const isConnected = gmailStatus === 'connected' || gmailStatus === 'active'

  return (
    <div className="p-4 md:p-6 pb-20 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-white mb-6">Settings</h1>
      
      <section className="bg-card rounded-2xl p-5 border border-white/5 space-y-4">
        <h2 className="text-lg font-semibold text-white border-b border-white/10 pb-3">Email Sync</h2>
        
        {isLoading ? (
          <div className="animate-pulse flex items-center h-12 bg-white/5 rounded-xl"></div>
        ) : (
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="font-bold text-white text-base">Gmail Integration</p>
              {isConnected ? (
                <div className="text-xs text-muted mt-1 space-y-1">
                  <p className="flex items-center text-accent font-medium">
                    <span className="mr-1">✓</span>
                    Gmail connected
                  </p>
                  {lastSync && <p>Last synced: {timeAgo(lastSync)}</p>}
                </div>
              ) : (
                <p className="text-xs text-muted mt-1">
                  Connect your Gmail to automatically sync GTBank and OPay transactions.
                </p>
              )}
            </div>

            <div className="shrink-0 w-full sm:w-auto">
              {isConnected ? (
                <button
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="w-full sm:w-auto h-12 px-6 flex items-center justify-center bg-white/5 hover:bg-white/10 text-white rounded-xl transition-colors text-sm font-bold disabled:opacity-50 min-h-[48px]"
                >
                  {isSyncing ? (
                    <span className="flex items-center gap-2">
                      <span className="animate-spin">⌛</span>
                      Syncing...
                    </span>
                  ) : (
                    'Sync Now'
                  )}
                </button>
              ) : (
                <button
                  onClick={handleConnect}
                  className="w-full sm:w-auto h-12 px-6 bg-accent text-black rounded-xl font-bold text-sm hover:bg-accent/90 transition-opacity min-h-[48px]"
                >
                  Connect Gmail
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
