// packages/core/src/hooks/useTransactionHistory.test.ts

import { renderHook, act } from '@testing-library/react-hooks';
import { useTransactionHistory } from './useTransactionHistory';

const TESTNET_ACCOUNT_A = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASUIYIC7FEM';
const TESTNET_ACCOUNT_B = 'GDRW7AJYGBJPJB5SPIZENZZZ45EIZHJOZDLUPZHX6X67KAGM3K3NX4VN';

describe('useTransactionHistory cross-account pagination regression', () => {
  it('refuses to run fetchNext when queryKey changes', async () => {
    const mockNext = jest.fn().mockResolvedValue({ records: [] });
    const mockCall = jest.fn().mockResolvedValue({
      records: [{ id: 'tx1' }],
      next: mockNext,
      prev: jest.fn(),
    });

    const mockServer: any = {
      transactions: () => ({
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
      ({ address }) => useTransactionHistory(mockServer, address),
      { initialProps: { address: TESTNET_ACCOUNT_A } }
    );

    await act(async () => {
      await Promise.resolve();
    });

    rerender({ address: TESTNET_ACCOUNT_B });

    await act(async () => {
      await result.current.fetchNext();
    });

    expect(mockNext).not.toHaveBeenCalled();
  });
});