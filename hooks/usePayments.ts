// packages/core/src/hooks/usePayments.ts

import { useEffect, useReducer, useCallback, useRef } from 'react';
import { Server, PaymentRecord } from 'stellar-sdk';
import { normalizePayment } from '../utils/normalizePayment'; // Adjust import path if necessary

interface UsePaymentsOptions {
  limit?: number;
  order?: 'asc' | 'desc';
  cursor?: string;
}

interface PaymentState {
  records: PaymentRecord[];
  queryKey: string;
  next: (() => Promise<void>) | null;
  prev: (() => Promise<void>) | null;
  hasNext: boolean;
  hasPrev: boolean;
  loading: boolean;
  error: Error | null;
}

type Action =
  | { type: 'FETCH_START'; queryKey: string }
  | { 
      type: 'FETCH_SUCCESS'; 
      queryKey: string; 
      records: PaymentRecord[]; 
      next: (() => Promise<void>) | null; 
      prev: (() => Promise<void>) | null; 
      hasNext: boolean; 
      hasPrev: boolean; 
    }
  | { type: 'FETCH_ERROR'; queryKey: string; error: Error };

function paymentsReducer(state: PaymentState, action: Action): PaymentState {
  switch (action.type) {
    case 'FETCH_START':
      return {
        ...state,
        queryKey: action.queryKey,
        loading: true,
        error: null,
      };
    case 'FETCH_SUCCESS':
      if (state.queryKey !== action.queryKey) return state;
      return {
        ...state,
        records: action.records,
        next: action.next,
        prev: action.prev,
        hasNext: action.hasNext,
        hasPrev: action.hasPrev,
        loading: false,
      };
    case 'FETCH_ERROR':
      if (state.queryKey !== action.queryKey) return state;
      return {
        ...state,
        loading: false,
        error: action.error,
      };
    default:
      return state;
  }
}

export function usePayments(server: Server, address: string | undefined, options: UsePaymentsOptions = {}) {
  const { limit = 10, order = 'desc', cursor } = options;
  const resolvedAddress = address;

  const queryKey = `${resolvedAddress}-${limit}-${order}-${cursor || ''}`;

  const [state, dispatch] = useReducer(paymentsReducer, {
    records: [],
    queryKey,
    next: null,
    prev: null,
    hasNext: false,
    hasPrev: false,
    loading: true,
    error: null,
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let active = true;
    dispatch({ type: 'FETCH_START', queryKey });

    if (!resolvedAddress) {
      dispatch({ 
        type: 'FETCH_SUCCESS', 
        queryKey, 
        records: [], 
        next: null, 
        prev: null, 
        hasNext: false, 
        hasPrev: false 
      });
      return;
    }

    let call = server.payments().forAccount(resolvedAddress).limit(limit).order(order);
    if (cursor) {
      call = call.cursor(cursor);
    }

    call.call()
      .then((res: any) => {
        if (!active) return;
        const records = res.records.map((rec: any) => normalizePayment(rec, resolvedAddress));
        const hasNext = res.records.length > 0;
        const hasPrev = res.records.length > 0;
        const next = hasNext ? async () => { await res.next(); } : null;
        const prev = hasPrev ? async () => { await res.prev(); } : null;

        dispatch({
          type: 'FETCH_SUCCESS',
          queryKey,
          records,
          next,
          prev,
          hasNext,
          hasPrev,
        });
      })
      .catch((err: Error) => {
        if (!active) return;
        dispatch({ type: 'FETCH_ERROR', queryKey, error: err });
      });

    return () => {
      active = false;
    };
  }, [server, resolvedAddress, limit, order, cursor, queryKey]);

  const fetchNext = useCallback(async () => {
    if (stateRef.current.queryKey !== queryKey) return;
    if (stateRef.current.next) {
      await stateRef.current.next();
    }
  }, [queryKey]);

  const fetchPrev = useCallback(async () => {
    if (stateRef.current.queryKey !== queryKey) return;
    if (stateRef.current.prev) {
      await stateRef.current.prev();
    }
  }, [queryKey]);

  return {
    payments: state.records,
    loading: state.loading,
    error: state.error,
    hasNext: state.hasNext,
    hasPrev: state.hasPrev,
    fetchNext,
    fetchPrev,
  };
}