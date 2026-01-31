"use client";

import { useState } from "react";
import {
  connectWallet,
  disconnectWallet,
  getConnectedAccount,
  isWalletConnected,
} from "@/lib/walletconnect";

export function WalletConnectButton() {
  const [connected, setConnected] = useState(isWalletConnected());
  const [address, setAddress] = useState<string | null>(
    getConnectedAccount()
  );
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { session, uri } = await connectWallet();

      if (uri) {
        // Show QR code modal with URI
        console.log("WalletConnect URI:", uri);
        // TODO: Display QR code in modal
      }

      if (session) {
        setConnected(true);
        setAddress(getConnectedAccount());
      }
    } catch (error) {
      console.error("Failed to connect wallet:", error);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectWallet();
      setConnected(false);
      setAddress(null);
    } catch (error) {
      console.error("Failed to disconnect wallet:", error);
    }
  };

  if (connected && address) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-600">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        <button
          onClick={handleDisconnect}
          className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleConnect}
      disabled={connecting}
      className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
    >
      {connecting ? "Connecting..." : "Connect External Wallet"}
    </button>
  );
}
