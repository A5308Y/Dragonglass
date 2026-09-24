module Gtd.Hierarchy exposing
    ( breadcrumb
    , breadcrumbFor
    , compareByOrder
    , descendantIds
    , isDescendantOf
    , area
    , root
    , leafTitle
    , separator
    )

{-| Reading the Project tree.

`parent_project_id` is authoritative, and a hand-edited vault can contain a cycle,
so every walk here carries the ids it has already seen and stops when one repeats.

-}

import Gtd.Data exposing (Project)
import Gtd.Id exposing (ProjectId)
import Set exposing (Set)


{-| What separates the levels of a breadcrumb, in pickers and in typed input alike.
-}
separator : String
separator =
    " > "


{-| The full `Root > Sub > Leaf` path of a Project.
-}
breadcrumb : List Project -> Project -> String
breadcrumb projects project =
    let
        walk seen current titles =
            if Set.member current.id seen then
                current.title :: titles

            else
                case current.parentProjectId |> Maybe.andThen (\parentId -> Gtd.Data.findProject parentId projects) of
                    Just parent ->
                        walk (Set.insert current.id seen) parent (current.title :: titles)

                    Nothing ->
                        current.title :: titles
    in
    walk Set.empty project [] |> String.join separator


{-| The breadcrumb of a Project id, when that Project still exists.
-}
breadcrumbFor : List Project -> ProjectId -> Maybe String
breadcrumbFor projects projectId =
    Gtd.Data.findProject projectId projects |> Maybe.map (breadcrumb projects)


isDescendantOf : ProjectId -> List Project -> Project -> Bool
isDescendantOf rootId projects project =
    let
        walk seen maybeId =
            case maybeId of
                Nothing ->
                    False

                Just currentId ->
                    if currentId == rootId then
                        True

                    else if Set.member currentId seen then
                        False

                    else
                        case Gtd.Data.findProject currentId projects of
                            Just parent ->
                                walk (Set.insert currentId seen) parent.parentProjectId

                            Nothing ->
                                False
    in
    walk Set.empty project.parentProjectId


{-| A Project's top-level ancestor, or the Project itself when it has no parent.
-}
root : List Project -> Project -> Project
root projects project =
    let
        walk seen current =
            if Set.member current.id seen then
                current

            else
                case current.parentProjectId |> Maybe.andThen (\parentId -> Gtd.Data.findProject parentId projects) of
                    Just parent ->
                        walk (Set.insert current.id seen) parent

                    Nothing ->
                        current
    in
    walk Set.empty project


{-| A Project's area: its top-level ancestor's, since only top-level Projects carry one.
-}
area : List Project -> Project -> Maybe String
area projects project =
    Gtd.Data.projectArea (root projects project)


{-| Every Project beneath one, at any depth.
-}
descendantIds : ProjectId -> List Project -> Set ProjectId
descendantIds rootId projects =
    projects
        |> List.filter (isDescendantOf rootId projects)
        |> List.map .id
        |> Set.fromList


{-| The segment after the last separator of a typed path, when the prefix names an
existing Project. `Heating > Heat pump` becomes `Heat pump`; an unresolvable prefix
such as `Nonsense > Heat pump` stays whole, so no parent is invented.
-}
leafTitle : String -> List Project -> String
leafTitle query projects =
    let
        typed =
            String.trim query

        separators =
            String.indexes ">" typed
    in
    case List.reverse separators |> List.head of
        Nothing ->
            typed

        Just separatorIndex ->
            let
                prefix =
                    String.left separatorIndex typed |> String.trim

                leaf =
                    String.dropLeft (separatorIndex + 1) typed |> String.trim

                normalized =
                    String.toLower prefix

                breadcrumbMatch =
                    List.any (\project -> String.toLower (breadcrumb projects project) == normalized) projects

                titleMatches =
                    List.filter (\project -> String.toLower project.title == normalized) projects |> List.length
            in
            if not (String.isEmpty prefix) && not (String.isEmpty leaf) && (breadcrumbMatch || titleMatches == 1) then
                leaf

            else
                typed


{-| Board priority first, then title, so an unordered Project sorts after ordered siblings.
-}
compareByOrder : Project -> Project -> Order
compareByOrder left right =
    case ( left.order, right.order ) of
        ( Just leftOrder, Just rightOrder ) ->
            compare ( leftOrder, left.title ) ( rightOrder, right.title )

        ( Just _, Nothing ) ->
            LT

        ( Nothing, Just _ ) ->
            GT

        ( Nothing, Nothing ) ->
            compare left.title right.title
