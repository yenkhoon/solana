import React from "react";
import {
  TransactionSignature,
  Connection,
  SystemProgram,
  Account,
  SignatureResult,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { useQuery } from "utils/url";
import { useCluster, Cluster, ClusterStatus } from "../cluster";
import {
  DetailsProvider,
  StateContext as DetailsStateContext,
} from "./details";
import base58 from "bs58";
import { useFetchAccountInfo } from "../accounts";
import { CACHED_STATUSES, isCached } from "./cached";

export enum FetchStatus {
  Fetching,
  FetchFailed,
  Fetched,
}

export type Confirmations = number | "max";

export type Timestamp = number | "unavailable";

export interface TransactionStatusInfo {
  slot: number;
  result: SignatureResult;
  timestamp: Timestamp;
  confirmations: Confirmations;
}

export interface TransactionStatus {
  fetchStatus: FetchStatus;
  signature: TransactionSignature;
  info?: TransactionStatusInfo;
}

type Transactions = { [signature: string]: TransactionStatus };
interface State {
  transactions: Transactions;
  url: string;
}

export enum ActionType {
  UpdateStatus,
  FetchSignature,
  Clear,
}

interface UpdateStatus {
  type: ActionType.UpdateStatus;
  url: string;
  signature: TransactionSignature;
  fetchStatus: FetchStatus;
  info?: TransactionStatusInfo;
}

interface FetchSignature {
  type: ActionType.FetchSignature;
  url: string;
  signature: TransactionSignature;
}

interface Clear {
  type: ActionType.Clear;
  url: string;
}

type Action = UpdateStatus | FetchSignature | Clear;
type Dispatch = (action: Action) => void;

function reducer(state: State, action: Action): State {
  if (action.type === ActionType.Clear) {
    return { url: action.url, transactions: {} };
  } else if (action.url !== state.url) {
    return state;
  }

  switch (action.type) {
    case ActionType.FetchSignature: {
      const signature = action.signature;
      const transaction = state.transactions[signature];
      if (transaction) {
        const transactions = {
          ...state.transactions,
          [action.signature]: {
            ...transaction,
            fetchStatus: FetchStatus.Fetching,
            info: undefined,
          },
        };
        return { ...state, transactions };
      } else {
        const transactions = {
          ...state.transactions,
          [action.signature]: {
            signature: action.signature,
            fetchStatus: FetchStatus.Fetching,
          },
        };
        return { ...state, transactions };
      }
    }

    case ActionType.UpdateStatus: {
      const transaction = state.transactions[action.signature];
      if (transaction) {
        const transactions = {
          ...state.transactions,
          [action.signature]: {
            ...transaction,
            fetchStatus: action.fetchStatus,
            info: action.info,
          },
        };
        return { ...state, transactions };
      }
      break;
    }
  }
  return state;
}

export const TX_ALIASES = ["tx", "txn", "transaction"];

const StateContext = React.createContext<State | undefined>(undefined);
const DispatchContext = React.createContext<Dispatch | undefined>(undefined);

type TransactionsProviderProps = { children: React.ReactNode };
export function TransactionsProvider({ children }: TransactionsProviderProps) {
  const { cluster, status: clusterStatus, url } = useCluster();
  const [state, dispatch] = React.useReducer(reducer, {
    transactions: {},
    url,
  });

  const fetchAccount = useFetchAccountInfo();
  const query = useQuery();
  const testFlag = query.get("test");

  // Check transaction statuses whenever cluster updates
  React.useEffect(() => {
    if (clusterStatus === ClusterStatus.Connecting) {
      dispatch({ type: ActionType.Clear, url });
    }

    // Create a test transaction
    if (cluster === Cluster.Devnet && testFlag !== null) {
      createTestTransaction(dispatch, fetchAccount, url, clusterStatus);
    }
  }, [testFlag, cluster, clusterStatus, url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <DetailsProvider>{children}</DetailsProvider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

async function createTestTransaction(
  dispatch: Dispatch,
  fetchAccount: (pubkey: PublicKey) => void,
  url: string,
  clusterStatus: ClusterStatus
) {
  const testKey = process.env.REACT_APP_TEST_KEY;
  let testAccount = new Account();
  if (testKey) {
    testAccount = new Account(base58.decode(testKey));
  }

  try {
    const connection = new Connection(url, "recent");
    const signature = await connection.requestAirdrop(
      testAccount.publicKey,
      100000
    );
    fetchTransactionStatus(dispatch, signature, url);
    fetchAccount(testAccount.publicKey);
  } catch (error) {
    console.error("Failed to create test success transaction", error);
  }

  try {
    const connection = new Connection(url, "recent");
    const tx = SystemProgram.transfer({
      fromPubkey: testAccount.publicKey,
      toPubkey: testAccount.publicKey,
      lamports: 1,
    });
    const signature = await sendAndConfirmTransaction(
      connection,
      tx,
      [testAccount],
      { confirmations: 1, skipPreflight: false }
    );
    fetchTransactionStatus(dispatch, signature, url);
  } catch (error) {
    console.error("Failed to create test failure transaction", error);
  }
}

export async function fetchTransactionStatus(
  dispatch: Dispatch,
  signature: TransactionSignature,
  url: string
) {
  dispatch({
    type: ActionType.FetchSignature,
    signature,
    url,
  });

  let fetchStatus;
  let info: TransactionStatusInfo | undefined;
  if (isCached(url, signature)) {
    info = CACHED_STATUSES[signature];
    fetchStatus = FetchStatus.Fetched;
  } else {
    try {
      const connection = new Connection(url);
      const { value } = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });

      if (value !== null) {
        let blockTime = null;
        try {
          blockTime = await connection.getBlockTime(value.slot);
        } catch (error) {
          console.error(
            "Failed to fetch block time for slot ",
            value.slot,
            ":",
            error
          );
        }
        let timestamp: Timestamp =
          blockTime !== null ? blockTime : "unavailable";

        let confirmations: Confirmations;
        if (typeof value.confirmations === "number") {
          confirmations = value.confirmations;
        } else {
          confirmations = "max";
        }

        info = {
          slot: value.slot,
          timestamp,
          confirmations,
          result: { err: value.err },
        };
      }
      fetchStatus = FetchStatus.Fetched;
    } catch (error) {
      console.error("Failed to fetch transaction status", error);
      fetchStatus = FetchStatus.FetchFailed;
    }
  }

  dispatch({
    type: ActionType.UpdateStatus,
    signature,
    fetchStatus,
    info,
    url,
  });
}

export function useTransactions() {
  const context = React.useContext(StateContext);
  if (!context) {
    throw new Error(
      `useTransactions must be used within a TransactionsProvider`
    );
  }
  return context;
}

export function useTransactionStatus(signature: TransactionSignature) {
  const context = React.useContext(StateContext);

  if (!context) {
    throw new Error(
      `useTransactionStatus must be used within a TransactionsProvider`
    );
  }

  return context.transactions[signature];
}

export function useTransactionDetails(signature: TransactionSignature) {
  const context = React.useContext(DetailsStateContext);

  if (!context) {
    throw new Error(
      `useTransactionDetails must be used within a TransactionsProvider`
    );
  }

  return context.entries[signature];
}

export function useFetchTransactionStatus() {
  const dispatch = React.useContext(DispatchContext);
  if (!dispatch) {
    throw new Error(
      `useFetchTransactionStatus must be used within a TransactionsProvider`
    );
  }

  const { url } = useCluster();
  return (signature: TransactionSignature) => {
    fetchTransactionStatus(dispatch, signature, url);
  };
}
