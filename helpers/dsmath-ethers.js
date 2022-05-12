const { ethers } = require("ethers");
BigNumber = ethers.BigNumber;

const WAD = ethers.utils.parseUnits('1');

module.exports = {    
    //rounds to zero if x*y < WAD / 2
    wmul: function(x, y) {
        return x.mul(y).add(WAD.div(2)).div(WAD);
    },
    
    //rounds to zero if x*y < WAD / 2
    wdiv: function(x, y) {
        return x.mul(WAD).add(y.div(2)).div(y);
    },
    
    wpow: function(x, n) {
        z = (!n.mod(2).eq(0)) ? x : WAD;
    
        for (n = n.div(2); !n.eq(0); n = n.div(2)) {
            x = this.wmul(x, x);
    
            if (!n.mod(2).eq(0)) {
                z = this.wmul(z, x);
            }
        }
        return z;
    }
}
