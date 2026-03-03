use core::array::ArrayTrait;
use core::poseidon::poseidon_hash_span;
// use core::debug::PrintTrait;

// ======================
// MERKLE VERIFY (binary tree, Poseidon)
// ======================
fn merkle_verify(leaf: felt252, mut proof: Array<felt252>, root: felt252) -> bool {
    // let mut current = leaf;

    // loop {
    //     if proof.len() == 0 {
    //         break;
    //     }
    //     let sibling = proof.pop_front().unwrap();

    //     // Hash avec index pair/impaire pour déterminer l'ordre
    //     if index % 2 == 0 {
    //         current = poseidon_hash_span(array![current, sibling].span());
    //     } else {
    //         current = poseidon_hash_span(array![sibling, current].span());
    //     }
    //     index /= 2;
    // };

    let mut hash = leaf;
    let mut i = 0_u32;
    while i < proof.len() {
        // println!("a,b: 0x{:x} 0x{:x}", hash, *proofEnter[i]);
        let hash_uint256: u256 = hash.into();
        let proof_item: u256 = (*proof[i]).into();
        if hash_uint256 < proof_item {
            hash = poseidon_hash_span(array![hash, *proof[i]].into());
            // println!("case 1: 0x{:x}", hash);
        } else {
            hash = poseidon_hash_span(array![*proof[i], hash].into());
            // println!("case 2: 0x{:x}", hash);

        }
        i += 1;
    }

    hash == root
}

// ======================
// MAIN – Le programme qui sera prouvé par S-two
// ======================
#[executable]
fn main(
    // ================== PUBLIC INPUTS (visibles dans la preuve)
    merkle_root: felt252,
    vote: u8,
    nullifier: felt252,
    round: felt252,
    // ================== PRIVATE INPUTS (cachés par la preuve)
    member_leaf: felt252, // hash de ton identifiant membre
    merkle_proof: Array<felt252>, // siblings (profondeur max ~20-25 ok en browser)
    secret: felt252 // ton secret privé (généré localement, jamais envoyé)
) -> (felt252, u8, felt252) { // retour = (merkle_root, vote, nullifier)
    // 1. Vote valide ?
    assert(vote >= 0_u8 && vote <= 3_u8, 'Invalid vote option');

    // 2. Nullifier correct ?
    let computed_nullifier = poseidon_hash_span(array![secret, round].span());
    assert(computed_nullifier == nullifier, 'Invalid nullifier');

    // 3. Appartenance à la liste des membres ?
    let is_member = merkle_verify(member_leaf, merkle_proof, merkle_root);
    assert(is_member, 'Not a member');

    // Tout est bon → on retourne les valeurs publiques
    // (le prover S-two prouvera que ces outputs sont corrects)
    (merkle_root, vote, nullifier)
}
