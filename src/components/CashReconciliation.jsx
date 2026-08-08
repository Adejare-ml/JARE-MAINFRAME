import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import { formatNaira } from '../lib/formatters';
import { toDateOnly, excludeVoided } from '../lib/queries';

export default function CashReconciliation({ onReconciled }) {
  const [cashWallet, setCashWallet] = useState(null);
  const [shouldShow, setShouldShow] = useState(false);
  const [showUpdateForm, setShowUpdateForm] = useState(false);
  const [actualCash, setActualCash] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // Minted when the update form opens; makes a retried submit a no-op instead
  // of a second adjustment.
  const [submissionId, setSubmissionId] = useState(null);

  useEffect(() => {
    checkTriggerConditions();
  }, []);

  const checkTriggerConditions = async () => {
    try {
      const now = new Date();
      
      // Only show after 8:00 PM (20:00) local time
      if (now.getHours() < 20) return;

      // Local date, not UTC: after 8pm Lagos this is always "today", but the
      // UTC form flips at 1am and re-prompted for a day already reconciled.
      const todayDate = toDateOnly(now);
      const isReconciled = localStorage.getItem('cash_reconciled_' + todayDate);
      
      if (isReconciled === 'true') return;

      // Check if Cash wallet exists
      const { data: wallets, error: walletError } = await supabase
        .from('wallets')
        .select('*')
        .ilike('name', '%Cash%');

      if (walletError) throw walletError;

      const wallet = wallets?.length > 0 ? wallets[0] : null;
      if (!wallet) return;

      // Check for manual transactions logged today
      // Existence check only -- no need to pull the row, let alone its email body.
      // Voided rows do not count: logging a cash spend and then striking it off
      // should leave the day looking un-reconciled, because it is.
      const { data: transactions, error: txError } = await excludeVoided(
        supabase
          .from('transactions')
          .select('id')
          .eq('wallet_id', wallet.id)
          .eq('transaction_date', todayDate)
          .eq('source', 'manual')
          .limit(1)
      );

      if (txError) throw txError;

      if (transactions && transactions.length > 0) {
        // Has manual transactions, no need to prompt
        return;
      }

      setCashWallet(wallet);
      setShouldShow(true);

    } catch (err) {
      console.error('Error checking cash reconciliation trigger:', err);
    }
  };

  const handleLooksRight = () => {
    localStorage.setItem('cash_reconciled_' + toDateOnly(new Date()), 'true');
    setShouldShow(false);
    if (onReconciled) onReconciled();
  };

  const handleUpdateSubmit = async (e) => {
    e.preventDefault();
    if (actualCash === '' || isNaN(actualCash)) {
      setError('Please enter a valid amount');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      const newBalance = parseFloat(actualCash);
      const diff = newBalance - (parseFloat(cashWallet.balance) || 0);

      const now = new Date();
      const today = toDateOnly(now);
      const nowTime = now.toTimeString().split(' ')[0]; // HH:MM:SS -- the
      // validator treats a shorter time as malformed and rewrites it to noon.

      if (diff !== 0) {
        const txType = diff > 0 ? 'credit' : 'debit';

        // Atomic + idempotent: the adjustment row and the balance delta land
        // together or not at all. The delta form (rather than writing
        // newBalance) means a stale read here cannot clobber a sync that
        // updated the wallet since the prompt rendered.
        const { error: rpcError } = await supabase.rpc('log_manual_transaction', {
          p_transaction_id: submissionId,
          p_wallet_id: cashWallet.id,
          p_type: txType,
          p_amount: Math.abs(diff),
          p_category: txType === 'credit' ? 'Cash Received' : 'Miscellaneous',
          p_note: 'Cash reconciliation adjustment',
          p_date: today,
          p_time: nowTime,
        });

        if (rpcError) throw rpcError;
      }

      localStorage.setItem('cash_reconciled_' + today, 'true');
      setShouldShow(false);
      
      toast.success('Cash balance updated to ' + formatNaira(newBalance) + ' ✓');
      
      if (onReconciled) onReconciled();

    } catch (err) {
      console.error('Error updating cash balance:', err);
      setError('Failed to update balance. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!shouldShow || !cashWallet) return null;

  return (
    <div className="bg-[#1a1a1a] rounded-xl p-5 shadow-sm border border-neutral-800 mb-6 text-[#f5f5f5]">
      <h3 className="text-lg font-bold mb-3">Quick cash check 💰</h3>
      
      {!showUpdateForm ? (
        <div>
          <p className="text-[#a0a0a0] mb-5">
            Your cash balance is <span className="text-white font-semibold">{formatNaira(cashWallet.balance)}</span>. Does that still look right?
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleLooksRight}
              className="flex-1 bg-[#22c55e] hover:bg-[#1ea951] text-white font-medium py-3 px-4 rounded-lg min-h-[48px] transition-colors"
            >
              Yes, looks right
            </button>
            <button
              onClick={() => {
                setSubmissionId(crypto.randomUUID())
                setShowUpdateForm(true)
              }}
              className="flex-1 bg-transparent border border-[#a0a0a0] hover:bg-neutral-800 text-white font-medium py-3 px-4 rounded-lg min-h-[48px] transition-colors"
            >
              No, let me update
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleUpdateSubmit} className="animate-fade-in">
          <p className="text-[#a0a0a0] mb-4">How much cash do you have right now?</p>
          
          <div className="relative mb-4">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#a0a0a0] font-medium">₦</span>
            <input
              type="number"
              step="0.01"
              value={actualCash}
              onChange={(e) => setActualCash(e.target.value)}
              placeholder="0.00"
              className="w-full bg-[#0f0f0f] border border-neutral-700 text-white rounded-lg py-3 pl-10 pr-4 min-h-[48px] focus:outline-none focus:border-[#22c55e]"
              required
            />
          </div>
          
          {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 bg-[#22c55e] hover:bg-[#1ea951] disabled:opacity-50 text-white font-medium py-3 px-4 rounded-lg min-h-[48px] transition-colors"
            >
              {isSubmitting ? 'Updating...' : 'Update balance'}
            </button>
            <button
              type="button"
              onClick={() => setShowUpdateForm(false)}
              className="px-4 py-3 min-h-[48px] font-medium text-[#a0a0a0] hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
