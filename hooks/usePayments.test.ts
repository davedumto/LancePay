// packages/core/src/hooks/usePayments.test.tsx

import { renderHook, act } from '@testing-library/react-hooks';
import { usePayments } from './usePayments';

// Use testnet only addresses as mandated
const TESTNET_ACCOUNT_A = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASUIYIC7FEM';
const TESTNET_ACCOUNT_B = 'GDRW7AJYGBJPJB5SPIZENZZZ45EIZHJOZDLUPZHX6X67KAGM3K3NX4VN';

describe('usePayments cross-account pagination regression', () => {
  it('does not execute stale pagination requests when address changes', async () => {
    const mockNext = jest.fn().mockResolvedValue({ records: [] });
    const mockCall = jest.fn().mockResolvedValue({
      records: [{ id: '1', type: 'payment', to: TESTNET_ACCOUNT_A }],
      next: mockNext,
      prev: jest.fn(),
    });

    const mockServer: any = {
      payments: () => ({
        forAccount: () => ({
          limit: () => ({
            order: () => ({
              cursor: () => ({ call: mockCall }),
              call: mockCall,
            }),
          }),
        }),
      }),
    };

    const { result, rerender } = renderHook(
      ({ address }) => usePayments(mockServer, address),
      { initialProps: { address: TESTNET_ACCOUNT_A } }
    );

    // Wait for initial fetch to land
    await act(async () => {
      await Promise.resolve();
    });

    // Change address immediately before next fetch
    rerender({ address: TESTNET_ACCOUNT_B });

    // Attempt to fetch next using stale closure callback reference
    await act(async () => {
      await result.current.fetchNext();
    });

    expect(mockNext).not.toHaveBeenCalled();
  });
});