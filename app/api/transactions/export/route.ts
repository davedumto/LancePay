import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import {
  fetchFullTransactionHistory,
  streamFullTransactionHistory,
} from "@/lib/stellar";
import { TransactionHistoryPDF } from "@/lib/transaction-pdf";
import { pdf } from "@react-pdf/renderer";
import React from "react";
import { logger } from '@/lib/logger'

// Helper to escape CSV fields
function csvEscape(value: string | number | null | undefined) {
  const str = String(value || "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const format = (searchParams.get("format") || "csv").toLowerCase();
    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");

    // Auth
    const authToken = request.headers
      .get("authorization")
      ?.replace("Bearer ", "");
    if (!authToken)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const claims = await verifyAuthToken(authToken);
    if (!claims)
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: { wallet: true },
    });

    if (!user || !user.wallet)
      return NextResponse.json(
        { error: "User or wallet not found" },
        { status: 404 },
      );

    const startDate = startDateParam ? new Date(startDateParam) : undefined;
    const endDate = endDateParam ? new Date(endDateParam) : undefined;

    const dateRangeStr =
      startDate && endDate
        ? `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`
        : `All Time`;

    // 4. Generate Output
    if (format === "csv") {
      const headers = [
        "Date",
        "Type",
        "Direction",
        "Amount",
        "Currency",
        "Description",
        "Client",
        "Invoice #",
        "Transaction Hash",
      ];

      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(headers.join(",") + "\n");

          // Fetch internal transactions in bulk for enrichment
          // Since we are streaming, we might want to pre-fetch these or fetch in chunks
          // For now, let's fetch those within the range if provided, else all for the user
          const internalTxs = await prisma.transaction.findMany({
            where: {
              userId: user.id,
              createdAt: {
                gte: startDate,
                lte: endDate,
              },
            },
            include: {
              invoice: true,
            },
          });
          const internalTxMap = new Map(
            internalTxs.map((tx) => [tx.txHash, tx]),
          );

          for await (const record of streamFullTransactionHistory(
            user.wallet!.address,
            startDate,
            endDate,
          )) {
            const txHash = record.transaction_hash;
            const internalTx = internalTxMap.get(txHash);

            const isIncoming = record.to === user.wallet?.address;
            const amount = Number(record.amount || 0);
            const currency =
              record.asset_code ||
              (record.asset_type === "native" ? "XLM" : "USDC");

            let description = "Transfer";
            let clientName = "";
            let invoiceNumber = "";

            if (internalTx) {
              description = internalTx.invoice?.description || internalTx.type;
              clientName = internalTx.invoice?.clientName || "";
              invoiceNumber = internalTx.invoice?.invoiceNumber || "";
            } else {
              if (record.type === "payment") {
                description = isIncoming
                  ? `Payment from ${record.from.slice(0, 4)}...`
                  : `Payment to ${record.to.slice(0, 4)}...`;
              } else if (record.type === "create_account") {
                description = "Account Funded";
              }
            }

            const row = [
              new Date(record.created_at).toISOString(),
              internalTx?.type || record.type,
              isIncoming ? "Incoming" : "Outgoing",
              amount.toFixed(2),
              currency,
              description,
              clientName,
              invoiceNumber,
              txHash,
            ];

            controller.enqueue(row.map(csvEscape).join(",") + "\n");
          }
          controller.close();
        },
      });

      return new NextResponse(stream, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="transactions-${dateRangeStr.replace(/\s/g, "_")}.csv"`,
        },
      });
    } else if (format === "pdf") {
      // 1. Fetch Stellar History (Paginated)
      const stellarTxs = await fetchFullTransactionHistory(
        user.wallet.address,
        startDate,
        endDate,
      );

      // 2. Fetch Internal History (to merge metadata)
      const internalTxs = await prisma.transaction.findMany({
        where: {
          userId: user.id,
          createdAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        include: {
          invoice: true,
        },
      });

      const internalTxMap = new Map(internalTxs.map((tx) => [tx.txHash, tx]));

      // 3. Merge & Format
      const mergedTransactions = stellarTxs.map((record) => {
        const txHash = record.transaction_hash;
        const internalTx = internalTxMap.get(txHash);

        const isIncoming = record.to === user.wallet?.address;
        let amount = Number(record.amount || 0);
        const currency =
          record.asset_code ||
          (record.asset_type === "native" ? "XLM" : "USDC");

        let description = "Transfer";
        let clientName = "";
        let invoiceNumber = "";

        if (internalTx) {
          description = internalTx.invoice?.description || internalTx.type;
          clientName = internalTx.invoice?.clientName || "";
          invoiceNumber = internalTx.invoice?.invoiceNumber || "";
        } else {
          if (record.type === "payment") {
            description = isIncoming
              ? `Payment from ${record.from.slice(0, 4)}...`
              : `Payment to ${record.to.slice(0, 4)}...`;
          } else if (record.type === "create_account") {
            description = "Account Funded";
          }
        }

        return {
          date: new Date(record.created_at),
          hash: txHash,
          type: internalTx?.type || record.type,
          amount: amount,
          currency,
          isIncoming,
          description,
          clientName,
          invoiceNumber,
          status: record.transaction_successful ? "completed" : "failed",
        };
      });

      // Sort by date desc
      mergedTransactions.sort((a, b) => b.date.getTime() - a.date.getTime());

      // Summary Calculations
      let totalIncoming = 0;
      let totalOutgoing = 0;

      mergedTransactions.forEach((tx) => {
        if (tx.currency === "USDC" || tx.currency === "XLM") {
          if (tx.isIncoming) totalIncoming += tx.amount;
          else totalOutgoing += tx.amount;
        }
      });

      const pdfData = {
        dateRange: dateRangeStr,
        generatedAt: new Date().toISOString(),
        user: {
          name: user.name || "User",
          email: user.email,
        },
        summary: {
          totalIncoming,
          totalOutgoing,
          netVolume: totalIncoming - totalOutgoing,
          currency: "USDC", // Dominant currency
        },
        transactions: mergedTransactions.map((tx) => ({
          date: tx.date.toISOString(),
          type: tx.type,
          description:
            tx.description + (tx.clientName ? ` (${tx.clientName})` : ""),
          amount: tx.amount,
          currency: tx.currency,
          status: tx.status,
          isIncoming: tx.isIncoming,
        })),
      };

      const stream = await pdf(
        React.createElement(TransactionHistoryPDF, {
          data: pdfData,
        }) as unknown as any,
      ).toBuffer();

      return new NextResponse(stream as any, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="transactions-${dateRangeStr.replace(/\s/g, "_")}.pdf"`,
        },
      });
    }

    return NextResponse.json({ error: "Invalid format" }, { status: 400 });
  } catch (error: any) {
    logger.error({ err: error }, "Export Error:");
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Internal Server Error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
