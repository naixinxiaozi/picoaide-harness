export interface AdmissionRejection {
  userId: number;
  username: string;
  endpoint: string;
  model: string;
  reason: string;
  requiredMoney: number;
  balanceMoney: number;
  at: string;
}

/** 进程级余额准入拒绝统计（供 server-info 读取，与网关服务共享）。 */
export const gatewayStats: {
  admissionRejections: number;
  lastRejection: AdmissionRejection | null;
} = {
  admissionRejections: 0,
  lastRejection: null,
};
