import React, { useState, useEffect } from 'react'
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
    await connectGmail()
    // Reload after a short delay in case mock token was used
    setTimeout(loadIntegrations, 1000)
  }

  const handleSync = async () => {
    setIsSyncing(true)
    await syncGmailEmails()
    await loadIntegrations()
    setIsSyncing(false)
  }

  return (
    <div className="p-4 md:p-6 pb-20 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      
      <section className="bg-card rounded-xl p-5 border border-white/5 space-y-4">
        <h2 className="text-xl font-semibold border-b border-white/10 pb-2">Email Sync</h2>
        
        {isLoading ? (
          <div className="animate-pulse flex items-center h-12 bg-white/5 rounded"></div>
        ) : (
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="font-medium text-lg">Gmail Integration</p>
              {gmailStatus === 'active' ? (
                <div className="text-sm text-muted mt-1 space-y-1">
                  <p className="flex items-center text-accent">
                    <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Gmail connected
                  </p>
                  {lastSync && <p>Last synced: {timeAgo(lastSync)}</p>}
                </div>
              ) : (
                <p className="text-sm text-muted mt-1">
                  Connect your Gmail to automatically sync GTBank and Opay transactions.
                </p>
              )}
            </div>

            <div className="shrink-0 w-full sm:w-auto">
              {gmailStatus === 'active' ? (
                <button
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="w-full sm:w-auto h-12 px-6 flex items-center justify-center bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors font-medium disabled:opacity-50"
                >
                  {isSyncing ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Syncing...
                    </>
                  ) : (
                    'Sync Now'
                  )}
                </button>
              ) : (
                <button
                  onClick={handleConnect}
                  className="w-full sm:w-auto h-12 px-6 bg-accent text-[#0f0f0f] rounded-lg font-medium hover:opacity-90 transition-opacity"
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
