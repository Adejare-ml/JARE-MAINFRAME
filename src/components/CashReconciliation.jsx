import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';

const formatNaira = (amount) => {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(amount || 0).replace('NGN', '₦');
};

export default function CashReconciliation({ onReconciled }) {
  const [cashWallet, setCashWallet] = useState(null);
  const [shouldShow, setShouldShow] = useState(false);
  const [showUpdateForm, setShowUpdateForm] = useState(false);
  const [actualCash, setActualCash] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    checkTriggerConditions();
  }, []);

  const checkTriggerConditions = async () => {
    try {
      const now = new Date();
      
      // Only show after 8:00 PM (20:00) local time
      if (now.getHours() < 20) return;

      const todayDate = now.toISOString().split('T')[0];
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
      const { data: transactions, error: txError } = await supabase
        .from('transactions')
        .select('*')
        .eq('wallet_id', wallet.id)
        .eq('transaction_date', todayDate)
        .eq('source', 'manual')
        .limit(1);

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
    const todayDate = new Date().toISOString().split('T')[0];
    localStorage.setItem('cash_reconciled_' + todayDate, 'true');
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
      const diff = newBalance - cashWallet.balance;

      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const nowTime = now.toTimeString().split(' ')[0].substring(0, 5); // HH:MM

      if (diff !== 0) {
        const txType = diff > 0 ? 'credit' : 'debit';
        const amount = Math.abs(diff);

        const newTx = {
          wallet_id: cashWallet.id,
          type: txType,
          source: 'manual',
          amount: amount,
          category: txType === 'credit' ? 'Cash Received' : 'Miscellaneous',
          description: 'Cash reconciliation adjustment',
          note: 'Cash reconciliation adjustment',
          reviewed: true,
          transaction_date: today,
          transaction_time: nowTime
        };

        const { error: insertError } = await supabase
          .from('transactions')
          .insert([newTx]);

        if (insertError) throw insertError;

        const { error: updateError } = await supabase
          .from('wallets')
          .update({ balance: newBalance, last_updated: new Date().toISOString() })
          .eq('id', cashWallet.id);

        if (updateError) throw updateError;
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
              onClick={() => setShowUpdateForm(true)}
              className="flex-1 bg-transparent border border-[#a0a0a0] hover:bg-neutral-800 text-white font-medium py-3 px-4 rounded-lg min-h-[48px] transition-colors"
            >
              No, let me update
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleUpdateSubmit} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
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
