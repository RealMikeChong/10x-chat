import type { ClientCore } from '../core.js';
import { RPCMethod, ShareAccess, SharePermission, ShareViewLevel } from '../rpc/types.js';
import { ShareStatus } from '../types.js';

export class SharingAPI {
  private readonly core: ClientCore;

  public constructor(core: ClientCore) {
    this.core = core;
  }

  public async getStatus(
    notebookId: string,
  ): Promise<ReturnType<typeof ShareStatus.fromApiResponse>> {
    console.debug(`Getting share status for notebook: ${notebookId}`);
    const params = [notebookId, [2]];
    const result = await this.core.rpcCall(
      RPCMethod.GET_SHARE_STATUS,
      params,
      `/notebook/${notebookId}`,
    );
    return ShareStatus.fromApiResponse(Array.isArray(result) ? result : [], notebookId);
  }

  public async setPublic(
    notebookId: string,
    publicShare: boolean,
  ): Promise<ReturnType<typeof ShareStatus.fromApiResponse>> {
    console.debug(`Setting notebook ${notebookId} public=${String(publicShare)}`);
    const access = publicShare ? ShareAccess.ANYONE_WITH_LINK : ShareAccess.RESTRICTED;
    const params = [[[notebookId, null, [access], [access, '']]], 1, null, [2]];

    await this.core.rpcCall(RPCMethod.SHARE_NOTEBOOK, params, `/notebook/${notebookId}`, true);
    return this.getStatus(notebookId);
  }

  public async setViewLevel(
    notebookId: string,
    level: ShareViewLevel,
  ): Promise<ReturnType<typeof ShareStatus.fromApiResponse>> {
    console.debug(`Setting notebook ${notebookId} view level to ${ShareViewLevel[level]}`);
    const params = [notebookId, [[null, null, null, null, null, null, null, null, [[level]]]]];

    await this.core.rpcCall(RPCMethod.RENAME_NOTEBOOK, params, `/notebook/${notebookId}`, true);

    const status = await this.getStatus(notebookId);
    return {
      notebookId: status.notebookId,
      isPublic: status.isPublic,
      access: status.access,
      viewLevel: level,
      sharedUsers: status.sharedUsers,
      shareUrl: status.shareUrl,
    };
  }

  public async addUser(
    notebookId: string,
    email: string,
    permission: SharePermission = SharePermission.VIEWER,
    notify = true,
    welcomeMessage = '',
  ): Promise<ReturnType<typeof ShareStatus.fromApiResponse>> {
    if (permission === SharePermission.OWNER) {
      throw new Error('Cannot assign OWNER permission');
    }

    if (permission === SharePermission._REMOVE) {
      throw new Error('Use removeUser() instead');
    }

    console.debug(
      `Adding user ${email} to notebook ${notebookId} with permission ${SharePermission[permission]}`,
    );

    const messageFlag = welcomeMessage ? 0 : 1;
    const notifyFlag = notify ? 1 : 0;

    const params = [
      [[notebookId, [[email, null, permission]], null, [messageFlag, welcomeMessage]]],
      notifyFlag,
      null,
      [2],
    ];

    await this.core.rpcCall(RPCMethod.SHARE_NOTEBOOK, params, `/notebook/${notebookId}`, true);
    return this.getStatus(notebookId);
  }

  public async updateUser(
    notebookId: string,
    email: string,
    permission: SharePermission,
  ): Promise<ReturnType<typeof ShareStatus.fromApiResponse>> {
    console.debug(
      `Updating user ${email} permission to ${SharePermission[permission]} in notebook ${notebookId}`,
    );
    return this.addUser(notebookId, email, permission, false);
  }

  public async removeUser(
    notebookId: string,
    email: string,
  ): Promise<ReturnType<typeof ShareStatus.fromApiResponse>> {
    console.debug(`Removing user ${email} from notebook ${notebookId}`);

    const params = [
      [[notebookId, [[email, null, SharePermission._REMOVE]], null, [0, '']]],
      0,
      null,
      [2],
    ];

    await this.core.rpcCall(RPCMethod.SHARE_NOTEBOOK, params, `/notebook/${notebookId}`, true);
    return this.getStatus(notebookId);
  }
}
