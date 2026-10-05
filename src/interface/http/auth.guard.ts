import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (README §2 — decisão D19).
 *
 * Não implementado no escopo do desafio: todas as requisições passam. O
 * desenho adotado seria OIDC client-credentials num IdP externo (Keycloak):
 * cada provedor é um client; este guard valida o JWT (assinatura via JWKS,
 * issuer, audience, expiração) e expõe `providerId` a partir de um claim, e o
 * controller exige `body.providerId === providerId` autenticado.
 */
export interface ProviderIdentity {
  providerId: string | undefined;
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ providerIdentity?: ProviderIdentity }>();
    request.providerIdentity = { providerId: undefined };
    return true;
  }
}
