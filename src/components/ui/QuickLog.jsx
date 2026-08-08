import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { toast } from '../../lib/toast';
import { CATEGORIES, getCategoryIcon } from '../../lib/constants';
import { toDateOnly } from '../../lib/queries';

const STEPS = {
  AMOUNT: 1,
  CATEGORY: 2,
  WALLET: 3,
  DETAILS: 4,
  CONFIRM: 5,
};

export default function QuickLog() {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(STEPS.AMOUNT);
  // Idempotency key, minted when the sheet opens. If "Log" is tapped twice, or
  // retried after a dropped connection, the second call hits the unique index
  // on (source, transaction_id) and the whole operation is a no-op -- no
  // duplicate row, no double balance delta.
  const [submissionId, setSubmissionId] = useState(null);
  
  const [type, setType] = useState('debit'); // 'debit' or 'credit'
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [wallet, setWallet] = useState(null);
  const [note, setNote] = useState('');
  const [wantOrNeed, setWantOrNeed] = useState(''); // 'need', 'want', 'obligation', 'emergency'
  
  const [wallets, setWallets] = useState([]);
  const [isLoadingWallets, setIsLoadingWallets] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSubmissionId(crypto.randomUUID());
      fetchWallets();
    } else {
      resetForm();
    }
  }, [isOpen]);

  const fetchWallets = async () => {
    setIsLoadingWallets(true);
    try {
      const { data, error } = await supabase
        .from('wallets')
        .select('id, name, balance, type');
      
      if (error) throw error;
      setWallets(data || []);
      if (data && data.length > 0 && !wallet) {
        setWallet(data[0]);
      }
    } catch (err) {
      console.error('Error fetching wallets:', err);
      toast.error('Failed to load wallets');
    } finally {
      setIsLoadingWallets(false);
    }
  };

  const resetForm = () => {
    setStep(STEPS.AMOUNT);
    setType('debit');
    setAmount('');
    setCategory('');
    setWallet(null);
    setNote('');
    setWantOrNeed('');
    setIsSubmitting(false);
  };

  const handleNext = () => setStep((s) => s + 1);
  const handleBack = () => setStep((s) => s - 1);

  const handleSubmit = async () => {
    if (!wallet || !amount || !category) {
      toast.error('Missing required fields');
      return;
    }

    setIsSubmitting(true);
    try {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        throw new Error('Invalid amount');
      }

      // Local date on purpose: the server clock is UTC, so letting it default
      // would file anything logged between midnight and 01:00 Lagos time to
      // yesterday.
      const now = new Date();
      const txDate = toDateOnly(now);
      const txTime = now.toTimeString().split(' ')[0];

      // One atomic call: insert + balance delta together, idempotent on
      // submissionId. Replaces an insert-then-update pair whose second half
      // failed after the first had committed -- the user was told the log
      // failed while the row existed, and a retry duplicated it.
      const { error } = await supabase.rpc('log_manual_transaction', {
        p_transaction_id: submissionId,
        p_wallet_id: wallet.id,
        p_type: type,
        p_amount: numAmount,
        p_category: category,
        p_note: note.trim() || null,
        p_want_or_need: wantOrNeed || null,
        p_date: txDate,
        p_time: txTime,
      });

      if (error) throw error;

      toast.success(`₦${numAmount.toLocaleString()} logged ✓`);
      setIsOpen(false);
    } catch (err) {
      console.error('Error logging transaction:', err);
      toast.error('Failed to log: ' + (err.message || 'check connection and retry'));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-20 right-4 lg:bottom-8 lg:right-8 z-40 bg-accent text-black font-extrabold w-14 h-14 rounded-full flex items-center justify-center text-3xl shadow-xl shadow-accent/25 hover:scale-110 active:scale-95 transition-all min-h-[48px] min-w-[48px]"
        aria-label="Quick log"
      >
        +
      </button>
    );
  }

  const renderAmount = () => (
    <div className="flex flex-col h-full space-y-6">
      <div className="flex bg-[#0f0f0f] rounded-xl p-1 border border-white/5">
        <button
          className={`flex-1 py-3 text-center rounded-lg text-xs font-bold transition-all min-h-[48px] ${type === 'debit' ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'text-muted hover:text-white'}`}
          onClick={() => setType('debit')}
        >
          💸 Debit (Expense)
        </button>
        <button
          className={`flex-1 py-3 text-center rounded-lg text-xs font-bold transition-all min-h-[48px] ${type === 'credit' ? 'bg-accent/20 text-accent border border-accent/30' : 'text-muted hover:text-white'}`}
          onClick={() => setType('credit')}
        >
          💰 Credit (Income)
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center py-6">
        <label className="text-xs text-muted font-semibold uppercase tracking-wider mb-2">Enter Amount</label>
        <div className="flex items-center text-4xl md:text-5xl font-extrabold text-white">
          <span className="text-accent mr-1">₦</span>
          <input
            type="number"
            inputMode="decimal"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="bg-transparent border-none outline-none w-full text-center placeholder-muted/30 focus:ring-0"
            placeholder="0"
          />
        </div>
      </div>

      <div className="flex space-x-3 pt-4">
        <button 
          onClick={() => setAmount('')}
          className="flex-1 bg-white/5 text-muted hover:text-white rounded-xl font-bold text-sm min-h-[48px] transition-colors"
        >
          Clear
        </button>
        <button 
          onClick={handleNext}
          disabled={!amount || parseFloat(amount) <= 0}
          className="flex-1 bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] disabled:opacity-50 hover:bg-accent/90 transition-colors"
        >
          Next →
        </button>
      </div>
    </div>
  );

  const renderCategory = () => (
    <div className="flex flex-col h-full space-y-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider">Select Category</p>
      
      <div className="flex-1 overflow-y-auto pr-1 pb-16 space-y-4 max-h-[50vh]">
        {Object.entries(CATEGORIES || {}).map(([section, cats]) => (
          <div key={section} className="space-y-2">
            <h4 className="text-[11px] font-bold text-muted/70 uppercase tracking-widest">{section}</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {cats.map(cat => {
                const icon = getCategoryIcon(cat);
                const isSelected = category === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => {
                      setCategory(cat);
                      setStep(STEPS.WALLET);
                    }}
                    className={`flex items-center gap-2 p-3 rounded-xl border text-left text-xs font-medium transition-all min-h-[48px] ${
                      isSelected ? 'bg-accent/20 border-accent text-white font-bold' : 'bg-white/5 border-white/5 text-muted hover:text-white hover:bg-white/10'
                    }`}
                  >
                    <span className="text-lg">{icon}</span>
                    <span className="truncate">{cat}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="pt-2">
        <button 
          onClick={handleNext}
          disabled={!category}
          className="w-full bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] disabled:opacity-50 hover:bg-accent/90 transition-colors"
        >
          Next →
        </button>
      </div>
    </div>
  );

  const renderWallet = () => (
    <div className="flex flex-col h-full space-y-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider">Select Wallet</p>
      
      {isLoadingWallets ? (
        <div className="flex-1 flex justify-center items-center">
          <span className="animate-spin text-2xl">⌛</span>
        </div>
      ) : (
        <div className="flex-1 space-y-2">
          {wallets.map(w => {
            const isSelected = wallet?.id === w.id;
            const icon = w.type === 'bank' ? '🏦' : w.type === 'mobile' ? '📱' : '💵';
            return (
              <button
                key={w.id}
                onClick={() => setWallet(w)}
                className={`w-full flex items-center justify-between p-4 rounded-2xl border transition-all min-h-[56px] ${
                  isSelected ? 'bg-accent/20 border-accent text-white' : 'bg-white/5 border-white/5 text-muted hover:text-white'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{icon}</span>
                  <div className="text-left">
                    <p className="font-bold text-white text-sm">{w.name}</p>
                    <p className="text-xs text-muted capitalize">{w.type}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-white">
                    ₦{parseFloat(w.balance || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}
                  </span>
                  {isSelected && <span className="text-accent text-lg font-bold">✓</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="pt-2 mt-auto">
        <button 
          onClick={handleNext}
          disabled={!wallet}
          className="w-full bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] disabled:opacity-50 hover:bg-accent/90 transition-colors"
        >
          Next →
        </button>
      </div>
    </div>
  );

  const renderDetails = () => (
    <div className="flex flex-col h-full space-y-4">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider">Details (Optional)</p>
      
      <div className="space-y-4 flex-1">
        <div>
          <label className="block text-xs font-medium text-muted mb-1">Note</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="what was this for?"
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/40 focus:outline-none focus:border-accent min-h-[48px]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted mb-1">Tag (Classification)</label>
          <div className="grid grid-cols-2 gap-2">
            {['need', 'want', 'obligation', 'emergency'].map(tag => (
              <button
                key={tag}
                type="button"
                onClick={() => setWantOrNeed(wantOrNeed === tag ? '' : tag)}
                className={`py-3 px-3 rounded-xl border text-xs font-bold uppercase tracking-wider transition-all min-h-[48px] ${
                  wantOrNeed === tag ? 'bg-accent/20 border-accent text-accent' : 'bg-white/5 border-white/5 text-muted hover:text-white'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="pt-2 mt-auto">
        <button 
          onClick={handleNext}
          className="w-full bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] hover:bg-accent/90 transition-colors"
        >
          {note || wantOrNeed ? 'Next → Summary' : 'Skip & Next →'}
        </button>
      </div>
    </div>
  );

  const renderConfirm = () => (
    <div className="flex flex-col h-full space-y-6">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider">Confirm Transaction</p>
      
      <div className="bg-background border border-white/10 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between border-b border-white/5 pb-3">
          <span className="text-muted text-xs">Amount</span>
          <span className={`text-2xl font-extrabold ${type === 'credit' ? 'text-accent' : 'text-white'}`}>
            {type === 'credit' ? '+' : '-'}₦{parseFloat(amount || 0).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Type</span>
          <span className="text-white font-bold capitalize">{type}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Category</span>
          <span className="text-white font-bold flex items-center gap-1">
            <span>{getCategoryIcon(category)}</span>
            <span>{category}</span>
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Wallet</span>
          <span className="text-white font-bold">{wallet?.name}</span>
        </div>
        {note && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">Note</span>
            <span className="text-white font-medium truncate max-w-[180px]">{note}</span>
          </div>
        )}
        {wantOrNeed && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">Tag</span>
            <span className="text-accent uppercase font-bold text-[10px]">{wantOrNeed}</span>
          </div>
        )}
      </div>

      <div className="pt-2 mt-auto">
        <button 
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="w-full bg-accent text-black rounded-xl font-extrabold text-base py-4 hover:bg-accent/90 transition-all shadow-lg shadow-accent/20 disabled:opacity-50 min-h-[48px] flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <span className="inline-block w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
          ) : (
            'Log It ✓'
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div 
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 animate-fade-in"
        onClick={() => setIsOpen(false)}
      />
      
      <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center">
        <div className="w-full max-w-lg bg-card border border-white/10 rounded-t-3xl shadow-2xl overflow-hidden flex flex-col animate-slide-up max-h-[90vh]">
          
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-card">
            {step > STEPS.AMOUNT ? (
              <button 
                onClick={handleBack}
                className="text-muted hover:text-white font-bold text-sm min-h-[48px] min-w-[48px] flex items-center"
              >
                ← Back
              </button>
            ) : (
              <div className="w-12" />
            )}
            
            <div className="flex space-x-1.5">
              {[1, 2, 3, 4, 5].map(s => (
                <div 
                  key={s} 
                  className={`h-1.5 rounded-full transition-all ${s === step ? 'w-6 bg-accent' : 'w-1.5 bg-white/20'}`}
                />
              ))}
            </div>

            <button 
              onClick={() => setIsOpen(false)}
              className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 text-muted hover:text-white flex items-center justify-center font-bold text-sm min-h-[48px] min-w-[48px]"
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="p-6 flex-1 overflow-y-auto">
            {step === STEPS.AMOUNT && renderAmount()}
            {step === STEPS.CATEGORY && renderCategory()}
            {step === STEPS.WALLET && renderWallet()}
            {step === STEPS.DETAILS && renderDetails()}
            {step === STEPS.CONFIRM && renderConfirm()}
          </div>
        </div>
      </div>
    </>
  );
}
