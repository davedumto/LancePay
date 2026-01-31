import { NextRequest, NextResponse } from "next/server";
import { signTransaction, signAndSubmitTransaction } from "@/lib/walletconnect";

/**
 * POST /api/walletconnect/sign
 * Sign a transaction using WalletConnect
 */
export async function POST(req: NextRequest) {
  try {
    const { xdr, submit = false } = await req.json();

    if (!xdr) {
      return NextResponse.json(
        { error: "Transaction XDR required" },
        { status: 400 }
      );
    }

    let result;
    if (submit) {
      // Sign and submit in one step
      result = await signAndSubmitTransaction(xdr);
    } else {
      // Just sign, return signed XDR
      const signedXdr = await signTransaction(xdr);
      result = { signedXdr };
    }

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("WalletConnect signing error:", error);
    return NextResponse.json(
      { error: "Failed to sign transaction" },
      { status: 500 }
    );
  }
}
