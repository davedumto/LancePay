interface WithdrawalRequest {
    amount: number
    bankAccountId: string
    userId: string
}

export async function initiateWithdrawal(request: WithdrawalRequest) {
    const response = await fetch('https://sandbox.api.yellowcard.io/business/payments', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.YELLOW_CARD_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            currency: 'USDC',
            network: 'stellar',
            amount: request.amount,
            destination: {
                type: 'bank_account',
                account_id: request.bankAccountId,
            },
            user_id: request.userId,
        }),
    })

    if (!response.ok) {
        throw new Error('Withdrawal failed')
    }

    return await response.json()
}
