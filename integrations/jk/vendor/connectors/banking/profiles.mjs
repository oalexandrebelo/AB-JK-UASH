// Reused from AB-UASH main: server/connectors/banking/profiles.ts. See integrations/jk/PROVENANCE.md.
export function getPixProviderProfile(provider, environment) {
    if (![
        'efi',
        'inter'
    ].includes(provider) || ![
        'homologation',
        'production'
    ].includes(environment)) throw new Error('INVALID_PIX_PROFILE');
    const origin = provider === 'efi' ? environment === 'production' ? 'https://pix.api.efipay.com.br' : 'https://pix-h.api.efipay.com.br' : environment === 'production' ? 'https://cdpj.partners.bancointer.com.br' : 'https://cdpj-sandbox.partners.uatinter.co';
    return Object.freeze({
        provider,
        environment,
        apiBaseUrl: origin + (provider === 'efi' ? '/v2' : '/pix/v2'),
        tokenUrl: origin + (provider === 'efi' ? '/oauth/token' : '/oauth/v2/token'),
        authentication: provider === 'efi' ? 'basic-json' : 'form',
        txidQuery: provider === 'efi' ? 'txid' : 'txId',
        scopes: Object.freeze([
            'cob.read',
            'cob.write',
            'pix.read'
        ]),
        documentation: provider === 'efi' ? 'https://dev.efipay.com.br/docs/api-pix/credenciais/' : 'https://developers.inter.co/references/pix'
    });
}
export function pixAllowedHosts(provider, environment) {
    const profile = getPixProviderProfile(provider, environment);
    return [
        ...new Set([
            new URL(profile.apiBaseUrl).hostname,
            new URL(profile.tokenUrl).hostname
        ])
    ];
}
