import { MOCK_USERS, API_KEY_TO_USER, UserRole } from '../../middleware/auth.js'
import type { AuthenticatedRequest } from '../../middleware/auth.js'
import { AuditLogService, AuditAction } from '../audit/index.js'
import type {
  AdminUser,
  AssignRoleRequest,
  AssignRoleResponse,
  RevokeApiKeyRequest,
  RevokeApiKeyResponse,
  ListUsersResponse,
  PaginationOptions,
} from './types.js'

/**
 * Admin service for managing users, roles, and API keys
 * Integrates with audit logging for compliance
 */
export class AdminService {
  private auditLog: AuditLogService

  constructor(auditLog: AuditLogService) {
    this.auditLog = auditLog
  }

  /**
   * List all users with pagination and filtering
   * 
   * @param adminId - ID of the admin requesting the list
   * @param adminEmail - Email of the admin
   * @param pagination - Pagination options
   * @param filters - Optional filters
   * @returns List of users and pagination info
   */
  async listUsers(
    adminId: string,
    adminEmail: string,
    pagination: PaginationOptions = {},
    filters?: { role?: UserRole; active?: boolean }
  ): Promise<ListUsersResponse> {
    const page = pagination.page ?? 1
    const limit = pagination.limit ?? 50
    const offset = pagination.offset ?? 0

    const tenantId = MOCK_USERS[adminId]?.tenantId || 'tenant-admin'

    // Log the list action
    void this.auditLog.logAction(tenantId, adminId, adminEmail, AuditAction.LIST_USERS, adminId, undefined, {
      limit,
      offset,
      filters,
    })

    // Get all users
    const users = Object.values(MOCK_USERS).map((user) => this.formatUser(user))

    // Apply filters if provided
    let filtered = users
    if (filters?.role) {
      filtered = filtered.filter((u) => u.role === filters.role)
    }
    if (filters?.active !== undefined) {
      filtered = filtered.filter((u) => u.active === filters.active)
    }

    // Paginate
    const total = filtered.length
    const paginated = filtered.slice(offset, offset + limit)

    return {
      users: paginated,
      page,
      total,
      limit,
      hasNext: offset + paginated.length < total,
      offset,
    }
  }

  /**
   * Assign a role to a user
   * 
   * @param adminId - ID of the admin performing the action
   * @param adminEmail - Email of the admin
   * @param request - Role assignment request
   * @returns Assignment response with updated user info
   * @throws Error if user not found or invalid role
   */
  async assignRole(
    adminId: string,
    adminEmail: string,
    request: AssignRoleRequest
  ): Promise<AssignRoleResponse> {
    const { userId, role } = request

    const tenantId = MOCK_USERS[adminId]?.tenantId || 'tenant-admin'

    // Validate role
    const validRoles = Object.values(UserRole)
    if (!validRoles.includes(role)) {
      void this.auditLog.logAction(
        tenantId,
        adminId,
        adminEmail,
        AuditAction.ASSIGN_ROLE,
        userId,
        undefined,
        { requestedRole: role },
        'failure',
        `Invalid role: ${role}`
      )
      throw new Error(`Invalid role: ${role}`)
    }

    const user = MOCK_USERS[userId]
    if (!user) {
      void this.auditLog.logAction(
        tenantId,
        adminId,
        adminEmail,
        AuditAction.ASSIGN_ROLE,
        userId,
        undefined,
        { requestedRole: role },
        'failure',
        'User not found'
      )
      throw new Error(`User not found: ${userId}`)
    }

    const oldRole = user.role
    user.role = role

    // Log the successful assignment
    await this.auditLog.logAction(
      tenantId,
      adminId,
      adminEmail,
      AuditAction.ASSIGN_ROLE,
      userId,
      user.email,
      { oldRole, newRole: role, targetUserEmail: user.email },
      'success'
    )

    return {
      success: true,
      user: this.formatUser(user),
      message: `Role updated from ${oldRole} to ${role}`,
    }
  }

  /**
   * Revoke an API key for a user
   * 
   * @param adminId - ID of the admin performing the action
   * @param adminEmail - Email of the admin
   * @param request - Revoke request
   * @returns Revoke response
   * @throws Error if key not found or doesn't belong to user
   */
  async revokeApiKey(
    adminId: string,
    adminEmail: string,
    request: RevokeApiKeyRequest
  ): Promise<RevokeApiKeyResponse> {
    const { userId, apiKey } = request

    const tenantId = MOCK_USERS[adminId]?.tenantId || 'tenant-admin'

    const user = MOCK_USERS[userId]
    if (!user) {
      void this.auditLog.logAction(
        tenantId,
        adminId,
        adminEmail,
        AuditAction.REVOKE_API_KEY,
        userId,
        undefined,
        { revokedKey: apiKey },
        'failure',
        'User not found'
      )
      throw new Error(`User not found: ${userId}`)
    }

    if (user.apiKey !== apiKey) {
      void this.auditLog.logAction(
        tenantId,
        adminId,
        adminEmail,
        AuditAction.REVOKE_API_KEY,
        userId,
        user.email,
        { revokedKey: apiKey, targetUserEmail: user.email },
        'failure',
        'API key does not belong to this user'
      )
      throw new Error('API key does not belong to this user')
    }

    // Generate new API key
    const oldKey = user.apiKey
    const newKey = this.generateApiKey()
    user.apiKey = newKey

    // Update the API key mapping
    delete API_KEY_TO_USER[oldKey]
    API_KEY_TO_USER[newKey] = userId

    // Log the successful revocation
    await this.auditLog.logAction(
      tenantId,
      adminId,
      adminEmail,
      AuditAction.REVOKE_API_KEY,
      userId,
      user.email,
      { revokedKey: oldKey, newKey, targetUserEmail: user.email },
      'success'
    )

    return {
      success: true,
      message: `API key revoked and replaced. New key issued.`,
    }
  }

  /**
   * Get audit logs with optional filtering
   * 
   * @param adminId - ID of the admin requesting logs
   * @param adminEmail - Email of the admin
   * @param filters - Filter options
   * @param limit - Max results
   * @param offset - Pagination offset
   * @returns Audit logs
   */
  getAuditLogs(
    adminId: string,
    adminEmail: string,
    filters: any,
    limit: number,
    offset: number,
    user: AuthenticatedRequest['user']
  ) {
    const options: { allowSuperScope?: boolean } = {}
    if (user?.role === UserRole.SUPER_ADMIN) {
      options.allowSuperScope = true
    }

    return this.auditLog.getLogs(
      user?.tenantId,
      {
        ...filters,
        actorId: filters?.actorId ?? filters?.adminId,
        resourceId: filters?.resourceId ?? filters?.targetUserId,
      },
      limit,
      offset,
      options
    )
  }

  /**
   * Export audit logs as an NDJSON stream
   *
   * @param adminId - ID of the admin requesting the export
   * @param adminEmail - Email of the admin
   * @param startDate - Start date of the export range
   * @param endDate - End date of the export range
   * @returns AsyncGenerator yielding redacted AuditLogEntry objects
   */
  exportAuditLogs(
    adminId: string,
    adminEmail: string,
    startDate: Date,
    endDate: Date,
    user: AuthenticatedRequest['user']
  ) {
    const tenantId = user?.tenantId || 'tenant-admin'

    // Log the initiation of the export
    void this.auditLog.logAction(tenantId, adminId, adminEmail, AuditAction.EXPORT_AUDIT_LOGS, adminId, undefined, {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      phase: 'initiation',
    })

    const options: { allowSuperScope?: boolean } = {}
    if (user?.role === UserRole.SUPER_ADMIN) {
      options.allowSuperScope = true
    }

    return this.auditLog.exportLogsStream(startDate, endDate, tenantId, options)
  }

  /**
   * Log the completion of an audit log export
   */
  logExportCompletion(
    adminId: string,
    adminEmail: string,
    startDate: Date,
    endDate: Date,
    recordCount: number
  ) {
    const tenantId = MOCK_USERS[adminId]?.tenantId || 'tenant-admin'
    void this.auditLog.logAction(tenantId, adminId, adminEmail, AuditAction.EXPORT_AUDIT_LOGS, adminId, undefined, {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      phase: 'completion',
      recordCount,
    })
  }

  /**
   * Format user for response (excludes internal details)
   */
  private formatUser(user: any): AdminUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      apiKey: user.apiKey,
      createdAt: new Date(Date.now() - 86400000 * 30).toISOString(), // Mock: 30 days ago
      lastActivity: new Date().toISOString(),
      active: true,
    }
  }

  /**
   * Generate a new API key
   */
  private generateApiKey(): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 15)
    return `api_${timestamp}_${random}`
  }
}

