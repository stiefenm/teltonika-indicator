// Passwort im GNOME-Schlüsselbund (libsecret)

import Secret from 'gi://Secret';

const ATTRS = {profile: 'default'};
let schema = null;

// Erst bei Bedarf anlegen – keine Objekte beim Laden des Moduls (EGO-Richtlinie)
function getSchema() {
    schema ??= new Secret.Schema('org.gnome.shell.extensions.teltonika-indicator',
        Secret.SchemaFlags.NONE, {profile: Secret.SchemaAttributeType.STRING});
    return schema;
}

export function lookupPassword(cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(getSchema(), ATTRS, cancellable, (_o, res) => {
            try {
                resolve(Secret.password_lookup_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function storePassword(password, cancellable = null) {
    return new Promise((resolve, reject) => {
        const done = (_o, res) => {
            try {
                resolve(password
                    ? Secret.password_store_finish(res)
                    : Secret.password_clear_finish(res));
            } catch (e) {
                reject(e);
            }
        };
        if (password) {
            Secret.password_store(getSchema(), ATTRS, Secret.COLLECTION_DEFAULT,
                'Teltonika Router Indicator', password, cancellable, done);
        } else {
            Secret.password_clear(getSchema(), ATTRS, cancellable, done);
        }
    });
}
