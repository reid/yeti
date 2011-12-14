function color (code, string) {
    return "\033[" + code + "m" + string + "\033[0m";
}

function factory (code) {
    return function (string) {
        return color(code, string);
    }
}

exports.codes = {
    bold : factory(1),
    red : factory(31),
    green : factory(32),
    blue : factory(34),
    gray : factory(90),
    debug : factory(90),
    info : factory(36),
    warn : factory(33),
    error : factory(31)
};
